#!/usr/bin/env node
// Append-only, content-addressed mirror of the production R2 bucket.
//
// A mirrored bucket is not enough protection on its own: a mirror that follows
// the source would propagate a deletion. This mirror instead stores every object
// version under `files/<sha256>/<original key>`, so
//
//   * deleting an object in production leaves the mirror copy untouched;
//   * replacing an object creates a second, differently-addressed copy;
//   * re-running is idempotent, and an existing mirror object is never replaced;
//   * the stored digest is the integrity check, independent of ETag semantics.
//
// It reads production and writes only to the backup bucket. There is no delete
// path, and the source bucket is never modified.
//
// Environment (never committed): CFLAB_BACKUP_BUCKET, CLOUDFLARE_ACCOUNT_ID,
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, plus CFLAB_FILES_BUCKET (default
// cflab-files) for the read-only source.
//
// Usage:
//   node scripts/backup/r2-mirror.mjs --plan
//   node scripts/backup/r2-mirror.mjs --apply [--limit 200]
//   node scripts/backup/r2-mirror.mjs --verify --manifest <manifest.json> [--sample 10]

import { pathToFileURL } from 'node:url';
import { createR2Client } from './r2-client.mjs';
import { r2FromEnvironment } from './upload-backups.mjs';
import { compactStamp, sha256Bytes, writeJsonFile } from './lib.mjs';

export const MIRROR_PREFIX = 'files';

export function mirrorKeyFor(key, sha256) {
  return `${MIRROR_PREFIX}/${sha256}/${key}`;
}

// Pure planning: which source objects still need a mirror copy, and which are
// already stored under their content address. Never proposes a deletion.
export function planMirror({ sourceObjects, mirroredKeys }) {
  const existing = new Set(mirroredKeys);
  const toCopy = [];
  for (const object of sourceObjects) {
    // A mirror object is addressed by content, so its presence can only be known
    // after hashing; objects without a recorded digest are always candidates.
    if (object.sha256 && existing.has(mirrorKeyFor(object.key, object.sha256))) continue;
    toCopy.push(object);
  }
  return { toCopy, alreadyMirrored: sourceObjects.length - toCopy.length };
}

// Copies the planned objects with bounded concurrency. Downloads and hashing stay
// ordered per object, and each object is written under its content address, so
// parallel copying cannot collide: two workers that hash identical content simply
// target the same key, and the destination client refuses to overwrite.
export async function copyPending({ source, destination, toCopy, mirroredKeys, concurrency = 4, limit, log = console.log }) {
  const existing = new Set(mirroredKeys);
  const entries = [];
  let started = 0;
  let applied = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, toCopy.length || 1)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= toCopy.length) return;
      if (limit !== undefined && started >= limit) return;
      started += 1;
      const object = toCopy[index];
      const body = await source.getObjectBuffer(object.key);
      if (!body) {
        log(`WARN  ${object.key} disappeared from the source before it could be copied; leaving the existing mirror alone`);
        continue;
      }
      const digest = sha256Bytes(body);
      const mirrorKey = mirrorKeyFor(object.key, digest);
      if (existing.has(mirrorKey)) {
        entries.push({ key: object.key, mirrorKey, sha256: digest, bytes: body.length, skipped: 'already mirrored' });
        continue;
      }
      await destination.putObject(mirrorKey, body, { contentType: 'application/octet-stream' });
      existing.add(mirrorKey);
      applied += 1;
      entries.push({ key: object.key, mirrorKey, sha256: digest, bytes: body.length, source_etag: object.etag, source_last_modified: object.lastModified });
    }
  });
  await Promise.all(workers);
  // The manifest must not depend on completion order.
  entries.sort((a, b) => (a.mirrorKey < b.mirrorKey ? -1 : a.mirrorKey > b.mirrorKey ? 1 : 0));
  return { entries, applied, started };
}

export async function mirror({ source, destination, apply = false, limit, concurrency = 4, log = console.log, stamp = compactStamp() }) {
  const sourceObjects = await source.listObjects({ prefix: '' });
  const mirrored = await destination.listObjects({ prefix: `${MIRROR_PREFIX}/` });
  const mirroredKeys = mirrored.map(object => object.key);
  const plan = planMirror({ sourceObjects, mirroredKeys });
  log(`${apply ? 'APPLY' : 'PLAN '} source ${sourceObjects.length} object(s), mirror ${mirroredKeys.length} object(s), to copy ${plan.toCopy.length}${apply && concurrency > 1 ? `, concurrency ${concurrency}` : ''}`);
  if (!apply) return { ...plan, entries: [], applied: 0 };

  const copied = await copyPending({ source, destination, toCopy: plan.toCopy, mirroredKeys, concurrency, limit, log });
  const manifest = {
    schema_version: 1,
    kind: 'r2-mirror',
    stamp,
    captured_at: new Date().toISOString(),
    source_bucket: source.bucket,
    destination_bucket: destination.bucket,
    source_objects: sourceObjects.length,
    mirrored_objects: mirroredKeys.length + copied.applied,
    copied_this_run: copied.applied,
    entries: copied.entries,
  };
  const manifestKey = `${MIRROR_PREFIX}/manifests/r2-${stamp}.json`;
  await destination.putObject(manifestKey, `${JSON.stringify(manifest, null, 2)}\n`, { contentType: 'application/json' });
  log(`OK    copied ${copied.applied} object(s) of ${copied.started} attempted; manifest ${manifestKey}`);
  return { ...plan, entries: copied.entries, applied: copied.applied, manifest, manifestKey };
}


export async function verifyMirror({ source, destination, manifest, sample = 0, log = console.log }) {
  const entries = manifest.entries ?? [];
  const selected = sample > 0 ? entries.filter((_, index) => index % Math.max(1, Math.ceil(entries.length / sample)) === 0).slice(0, sample) : entries;
  const problems = [];
  for (const entry of selected) {
    const body = await destination.getObjectBuffer(entry.mirrorKey);
    if (!body) {
      problems.push(`${entry.mirrorKey} is missing from the mirror`);
      continue;
    }
    const digest = sha256Bytes(body);
    if (digest !== entry.sha256) problems.push(`${entry.mirrorKey} hashes to ${digest.slice(0, 16)}… but the manifest records ${entry.sha256.slice(0, 16)}…`);
  }
  log(`${problems.length ? 'FAIL ' : 'OK   '} verified ${selected.length} of ${entries.length} mirrored object(s)`);
  for (const problem of problems) log(`      ${problem}`);
  return { ok: problems.length === 0, verified: selected.length, problems };
}

// The source is read-only and defaults to the production file bucket: the client
// is created with readOnly so a write to production is impossible, not just unused.
//
// Production reads use their OWN credentials (R2_SOURCE_ACCESS_KEY_ID /
// R2_SOURCE_SECRET_ACCESS_KEY), because an R2 API token carries a single
// permission level: one token scoped "Object Read" on cflab-files and a different
// token scoped "Object Read & Write" on the backup bucket. There is deliberately
// no fallback to the write-capable pair.
export function sourceClientFromEnvironment(env = process.env, { fetchImpl } = {}) {
  const bucket = env.CFLAB_FILES_BUCKET ?? 'cflab-files';
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_SOURCE_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SOURCE_SECRET_ACCESS_KEY;
  const missing = Object.entries({
    CLOUDFLARE_ACCOUNT_ID: accountId,
    R2_SOURCE_ACCESS_KEY_ID: accessKeyId,
    R2_SOURCE_SECRET_ACCESS_KEY: secretAccessKey,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`missing production read configuration: ${missing.join(', ')} (separate from the backup credentials; see docs/BACKUP-RESTORE.md)`);
  }
  return createR2Client({ accountId, bucket, accessKeyId, secretAccessKey, fetchImpl, readOnly: true });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage:',
      '  node scripts/backup/r2-mirror.mjs --plan',
      '  node scripts/backup/r2-mirror.mjs --apply [--limit 200] [--report <file>]',
      '  node scripts/backup/r2-mirror.mjs --verify --manifest <mirror manifest.json> [--sample 10]',
    ].join('\n'));
    return;
  }
  const source = sourceClientFromEnvironment();
  const destination = r2FromEnvironment();
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex === -1 ? undefined : Number(args[limitIndex + 1]);
  const concurrencyIndex = args.indexOf('--concurrency');
  const concurrency = concurrencyIndex === -1 ? 8 : Math.max(1, Math.min(16, Number(args[concurrencyIndex + 1])));

  if (args.includes('--verify')) {
    const manifestIndex = args.indexOf('--manifest');
    if (manifestIndex === -1) throw new Error('--verify needs --manifest <file>');
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(args[manifestIndex + 1], 'utf8'));
    const sampleIndex = args.indexOf('--sample');
    const result = await verifyMirror({ source, destination, manifest, sample: sampleIndex === -1 ? 0 : Number(args[sampleIndex + 1]) });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const result = await mirror({ source, destination, apply: args.includes('--apply'), limit, concurrency });
  const reportIndex = args.indexOf('--report');
  if (reportIndex !== -1 && result.manifest) writeJsonFile(args[reportIndex + 1], result.manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
