#!/usr/bin/env node
// Recover production file objects from the append-only R2 mirror.
//
// The mirror stores every production object version under
// `files/<sha256>/<original key>`, so this script can list the versions the mirror
// holds for a key, download one to an isolated local directory, and verify that the
// bytes hash to the content address they were stored under.
//
// It is read-only on both buckets: it never writes to production, never deletes,
// and never modifies the mirror. Applying a recovered object is a deliberate human
// step described in docs/BACKUP-RESTORE.md.
//
// Usage:
//   node scripts/backup/r2-recover.mjs --list <key>            # versions in the mirror
//   node scripts/backup/r2-recover.mjs --list-duplicates       # keys with >1 version
//   node scripts/backup/r2-recover.mjs --key <key> --sha256 <digest> --out <dir>
//   node scripts/backup/r2-recover.mjs --key <key> --out <dir> # newest version

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createR2Client } from './r2-client.mjs';
import { r2FromEnvironment } from './upload-backups.mjs';
import { sha256Bytes, writeJsonFile } from './lib.mjs';
import { MIRROR_PREFIX, sourceClientFromEnvironment } from './r2-mirror.mjs';

// A mirror key is `files/<sha256>/<original key>`; recovery follows from taking it
// apart rather than trusting the listing order.
export function parseMirrorKey(mirrorKey) {
  if (!mirrorKey.startsWith(`${MIRROR_PREFIX}/`)) return null;
  const rest = mirrorKey.slice(MIRROR_PREFIX.length + 1);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;
  const digest = rest.slice(0, separator);
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  return { sha256: digest, key: rest.slice(separator + 1) };
}

// Groups mirror objects by the production key they came from, newest first.
export function versionsByKey(mirrorObjects) {
  const grouped = new Map();
  for (const object of mirrorObjects) {
    const parsed = parseMirrorKey(object.key);
    if (!parsed) continue;
    const versions = grouped.get(parsed.key) ?? [];
    versions.push({ ...parsed, mirrorKey: object.key, size: object.size, lastModified: object.lastModified });
    grouped.set(parsed.key, versions);
  }
  for (const versions of grouped.values()) {
    versions.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)) || (a.sha256 < b.sha256 ? -1 : 1));
  }
  return grouped;
}

// What recovery is available for one key. Object listings carry no content digest,
// so the comparison against production is only meaningful when the caller supplies
// the digest it computed from the bytes it read: 'not checked' is reported instead
// of guessing.
export function describeRecovery({ mirrorObjects, key, productionDigest }) {
  const versions = versionsByKey(mirrorObjects).get(key) ?? [];
  const known = typeof productionDigest === 'string' && productionDigest.length > 0;
  return {
    key,
    mirrorVersions: versions.length,
    productionVersion: known ? productionDigest : 'not checked',
    currentVersionMirrored: known ? versions.some(version => version.sha256 === productionDigest) : 'not checked',
    supersededVersions: known ? versions.filter(version => version.sha256 !== productionDigest) : [],
    versions,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage:',
      '  node scripts/backup/r2-recover.mjs --list <key>',
      '  node scripts/backup/r2-recover.mjs --list-duplicates [--limit 20]',
      '  node scripts/backup/r2-recover.mjs --key <key> [--sha256 <digest>] --out <dir> [--report <file>]',
    ].join('\n'));
    return;
  }
  const value = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const key = value('--list') ?? value('--key');

  const mirror = r2FromEnvironment();
  const mirrorObjects = (await mirror.listObjects({ prefix: `${MIRROR_PREFIX}/` })).filter(object => parseMirrorKey(object.key));
  const grouped = versionsByKey(mirrorObjects);

  if (args.includes('--list-duplicates')) {
    const limit = Number(value('--limit') ?? 20);
    const duplicates = [...grouped.entries()].filter(([, versions]) => versions.length > 1).sort((a, b) => b[1].length - a[1].length);
    console.log(`mirror holds ${mirrorObjects.length} object version(s) for ${grouped.size} production key(s); ${duplicates.length} key(s) have more than one version`);
    for (const [duplicateKey, versions] of duplicates.slice(0, limit)) {
      console.log(`  ${duplicateKey}: ${versions.length} versions`);
      for (const version of versions) console.log(`     sha256 ${version.sha256}  ${version.size} bytes  ${version.lastModified ?? ''}`);
    }
    return;
  }

  if (!key) throw new Error('--list <key>, --list-duplicates, or --key <key> is required');
  const versions = grouped.get(key) ?? [];
  if (!versions.length) throw new Error(`the mirror holds no version of ${key}`);

  // Comparing against production needs the production bytes: listings have no digest.
  // Recovery still works without production credentials, and says so.
  let source = null;
  try {
    source = sourceClientFromEnvironment();
  } catch {
    source = null;
  }
  let productionBytes;
  let productionDigest;
  if (source) {
    const body = await source.getObjectBuffer(key);
    if (body) {
      productionBytes = body.length;
      productionDigest = sha256Bytes(body);
    } else {
      console.log(`note  production no longer holds ${key}`);
    }
  } else {
    console.log('note  production was not read (no R2_SOURCE_* read-only credentials in this environment)');
  }
  const recovery = describeRecovery({ mirrorObjects, key, productionDigest });
  console.log(`${key}: ${recovery.mirrorVersions} mirrored version(s); production version ${recovery.productionVersion}`);
  if (recovery.supersededVersions.length) {
    console.log(`      ${recovery.supersededVersions.length} superseded version(s) are still recoverable`);
  }
  for (const version of versions) {
    const tag = version.sha256 === productionDigest ? ' == production' : '';
    console.log(`  sha256 ${version.sha256}  ${String(version.size).padStart(10)} bytes  ${version.lastModified ?? ''}${tag}`);
  }
  if (args.includes('--list')) return;

  const wanted = value('--sha256');
  const chosen = wanted ? versions.find(version => version.sha256 === wanted) : versions[0];
  if (!chosen) throw new Error(`the mirror holds no version of ${key} with sha256 ${wanted}`);
  const outDir = value('--out');
  if (!outDir) throw new Error('--out <dir> is required to retrieve a version');

  const body = await mirror.getObjectBuffer(chosen.mirrorKey);
  if (!body) throw new Error(`${chosen.mirrorKey} is missing from the mirror`);
  const digest = sha256Bytes(body);
  if (digest !== chosen.sha256) throw new Error(`retrieved bytes hash to ${digest}, but the mirror key records ${chosen.sha256}`);

  const target = path.join(outDir, key);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  const matchesProduction = productionDigest === undefined ? 'not checked' : digest === productionDigest;
  console.log(`OK    recovered ${key} (${body.length} bytes, sha256 ${digest.slice(0, 16)}...) -> ${target}`);
  console.log(`      matches the current production object: ${matchesProduction}`);
  const report = value('--report');
  if (report) {
    writeJsonFile(report, {
      key, mirrorKey: chosen.mirrorKey, sha256: digest, bytes: body.length,
      productionBytes, productionDigest: productionDigest ?? 'not checked', matchesProduction,
      recoveredTo: target, recoveredAt: new Date().toISOString(),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

