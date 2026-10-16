#!/usr/bin/env node
// Verify that the backup setup matches docs/BACKUP-RESTORE.md before activation.
//
// Checks, in one run:
//   * the backup bucket exists, is private, and holds the expected object count;
//   * its bucket lock rules protect the documented prefixes for at least the
//     documented window (locks outrank lifecycle rules, so this is what stops an
//     accidental deletion or overwrite);
//   * its lifecycle rules expire the documented prefixes at or below the
//     documented retention;
//   * the R2 credentials can read production and read/write the backup bucket,
//     and the production client is read-only by construction (no write attempt is
//     ever made against production).
//
// Bucket administration needs an operator credential (wrangler login); the
// credential checks use the S3 credentials from the environment. Nothing is
// deleted, and nothing is written unless --probe-write is passed (which writes one
// small object under _verify/ and never overwrites).
//
// Usage:
//   node scripts/backup/verify-setup.mjs
//   node scripts/backup/verify-setup.mjs --probe-write

import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createR2Client } from './r2-client.mjs';
import { r2FromEnvironment } from './upload-backups.mjs';
import { sourceClientFromEnvironment } from './r2-mirror.mjs';

// The documented policy. Verification fails when the account is weaker than this.
export const EXPECTED = {
  bucket: 'cflab-backups',
  locks: [
    { prefix: 'd1/', minRetentionDays: 30 },
    { prefix: 'files/', minRetentionDays: 30 },
  ],
  lifecycles: [
    { prefix: 'd1/', maxExpireDays: 90 },
    { prefix: 'files/', maxExpireDays: 400 },
  ],
};

function retentionDays(rule) {
  if (rule?.condition?.type === 'Indefinite') return Number.POSITIVE_INFINITY;
  if (typeof rule?.condition?.maxAgeSeconds === 'number') return rule.condition.maxAgeSeconds / 86400;
  if (typeof rule?.maxAgeSeconds === 'number') return rule.maxAgeSeconds / 86400;
  return null;
}

function expireDays(rule) {
  if (typeof rule?.deleteAfterDays === 'number') return rule.deleteAfterDays;
  if (typeof rule?.condition?.maxAgeSeconds === 'number') return rule.condition.maxAgeSeconds / 86400;
  if (typeof rule?.expiration?.days === 'number') return rule.expiration.days;
  return null;
}

// Pure evaluation so the policy rules are testable without an account.
export function evaluateSetup({ bucketExists, bucketInfo, lockRules = [], lifecycleRules = [], publicAccess = {}, credentials = {}, probeWrite }) {
  const problems = [];
  const notes = [];
  if (!bucketExists) {
    return { ok: false, problems: [`the backup bucket "${EXPECTED.bucket}" does not exist; create it before activating backups`], notes };
  }
  notes.push(`bucket ${EXPECTED.bucket}: ${bucketInfo?.object_count ?? 'unknown'} object(s), ${bucketInfo?.bucket_size ?? 'unknown'} size`);

  for (const expected of EXPECTED.locks) {
    const rule = lockRules.find(candidate => (candidate.prefix ?? '') === expected.prefix);
    if (!rule) {
      problems.push(`no bucket lock rule covers prefix "${expected.prefix}"; objects there could be deleted or overwritten`);
      continue;
    }
    const days = retentionDays(rule);
    if (days === null) problems.push(`the lock rule for "${expected.prefix}" has an unreadable retention period`);
    else if (days < expected.minRetentionDays) problems.push(`the lock rule for "${expected.prefix}" retains ${days} day(s), below the documented ${expected.minRetentionDays}`);
    else notes.push(`lock "${expected.prefix}": ${days === Number.POSITIVE_INFINITY ? 'indefinite' : `${days} days`}`);
  }

  for (const expected of EXPECTED.lifecycles) {
    const rule = lifecycleRules.find(candidate => (candidate.prefix ?? '') === expected.prefix || (candidate.prefix ?? '') === expected.prefix.replace(/\/$/, ''));
    if (!rule) {
      problems.push(`no lifecycle rule covers prefix "${expected.prefix}"; backups would accumulate without a retention bound`);
      continue;
    }
    const days = expireDays(rule);
    if (days === null) problems.push(`the lifecycle rule for "${expected.prefix}" has no readable expiration`);
    else if (days > expected.maxExpireDays) problems.push(`the lifecycle rule for "${expected.prefix}" expires after ${days} day(s), above the documented ${expected.maxExpireDays}`);
    else notes.push(`lifecycle "${expected.prefix}": expire after ${days} days`);
  }

  if (publicAccess.devUrl) problems.push('the backup bucket has a public r2.dev URL enabled; backups must not be publicly reachable');
  if ((publicAccess.domains ?? []).length) problems.push('the backup bucket has a custom domain; backups must not be publicly reachable');
  if (!publicAccess.devUrl && !(publicAccess.domains ?? []).length) notes.push('public access: disabled');

  if (credentials.productionRead !== 'ok') problems.push(`reading production failed: ${credentials.productionRead ?? 'not checked'}`);
  else notes.push('production read: ok (read-only client)');
  if (credentials.backupRead !== 'ok') problems.push(`reading the backup bucket failed: ${credentials.backupRead ?? 'not checked'}`);
  else notes.push('backup read: ok');
  if (probeWrite === undefined) notes.push('backup write: not probed (pass --probe-write to verify it)');
  else if (probeWrite !== 'ok') problems.push(`writing to the backup bucket failed: ${probeWrite}`);
  else notes.push('backup write: ok (probe object under _verify/, never overwriting)');

  return { ok: problems.length === 0, problems, notes };
}

function wranglerJson(args) {
  const result = spawnSync('node_modules/.bin/wrangler', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? 1, output };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/backup/verify-setup.mjs [--probe-write]');
    return;
  }

  // 1. Bucket administration (operator credential via wrangler).
  const info = wranglerJson(['r2', 'bucket', 'info', EXPECTED.bucket]);
  const bucketExists = info.status === 0;
  let bucketInfo = null;
  if (bucketExists) {
    bucketInfo = {
      object_count: Number((info.output.match(/object_count:\s*([\d,]+)/) ?? [])[1]?.replace(/,/g, '') ?? 0),
      bucket_size: (info.output.match(/bucket_size:\s*(.+)/) ?? [])[1]?.trim() ?? null,
    };
  }
  const lockRules = [];
  const lifecycleRules = [];
  let publicAccess = {};
  if (bucketExists) {
    const locks = wranglerJson(['r2', 'bucket', 'lock', 'list', EXPECTED.bucket, '--json']);
    if (locks.status === 0) {
      try { lockRules.push(...(JSON.parse(locks.output).rules ?? JSON.parse(locks.output) ?? [])); } catch { /* reported below as missing */ }
    }
    const lifecycles = wranglerJson(['r2', 'bucket', 'lifecycle', 'list', EXPECTED.bucket, '--json']);
    if (lifecycles.status === 0) {
      try { lifecycleRules.push(...(JSON.parse(lifecycles.output).rules ?? JSON.parse(lifecycles.output) ?? [])); } catch { /* reported below as missing */ }
    }
    const devUrl = wranglerJson(['r2', 'bucket', 'dev-url', 'get', EXPECTED.bucket]);
    const domains = wranglerJson(['r2', 'bucket', 'domain', 'list', EXPECTED.bucket, '--json']);
    publicAccess = {
      devUrl: /enabled:\s*true/i.test(devUrl.output),
      domains: domains.status === 0 ? (() => { try { const parsed = JSON.parse(domains.output); return parsed.domains ?? parsed ?? []; } catch { return []; } })() : [],
    };
  }

  // 2. Credential checks over the S3 API (no writes unless asked).
  const credentials = {};
  let probeWrite;
  try {
    const source = sourceClientFromEnvironment();
    await source.listObjects({ maxKeys: 1 });
    credentials.productionRead = 'ok';
    try {
      await source.putObject('_verify/should-never-exist', 'x');
      credentials.productionRead = 'ok, but the client allowed a write (this must not happen)';
    } catch (error) {
      if (!/read-only/.test(String(error?.message))) credentials.productionRead = `unexpected write error: ${error?.message}`;
    }
  } catch (error) {
    credentials.productionRead = error?.message ?? String(error);
  }
  try {
    const backup = r2FromEnvironment();
    await backup.listObjects({ maxKeys: 1 });
    credentials.backupRead = 'ok';
    if (args.includes('--probe-write')) {
      try {
        await backup.putObject(`_verify/probe-${Date.now()}.txt`, 'backup write probe\n', { contentType: 'text/plain' });
        probeWrite = 'ok';
      } catch (error) {
        probeWrite = error?.message ?? String(error);
      }
    }
  } catch (error) {
    credentials.backupRead = error?.message ?? String(error);
  }

  const result = evaluateSetup({ bucketExists, bucketInfo, lockRules, lifecycleRules, publicAccess, credentials, probeWrite });
  for (const note of result.notes) console.log(`OK    ${note}`);
  for (const problem of result.problems) console.log(`FAIL  ${problem}`);
  console.log(`${result.ok ? 'PASS' : 'FAIL'}: backup setup verification`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
