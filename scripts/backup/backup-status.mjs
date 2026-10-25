#!/usr/bin/env node
// Backup freshness and inventory report.
//
// Reads only: it lists the backup bucket, loads the newest manifest per database,
// and reports age, size, checksum, and row totals. It fails when a database has no
// usable backup inside the allowed age, which is what turns a silent backup
// outage into a failed workflow run.
//
// Usage: node scripts/backup/backup-status.mjs [--max-age-hours 30] [--json]

import { pathToFileURL } from 'node:url';
import { createR2Client } from './r2-client.mjs';
import { r2FromEnvironment } from './upload-backups.mjs';
import { validateManifest } from './lib.mjs';

export const DEFAULT_MAX_AGE_HOURS = 30;

// Pure decision function so the freshness rule is testable without a network.
export function assessFreshness({ databases, manifests, now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS }) {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('maxAgeHours must be positive and finite');
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const report = [];
  const stale = [];
  for (const database of databases) {
    const forDatabase = manifests
      .filter(entry => entry.manifest?.database === database)
      .filter(entry => !(entry.problems?.length) && Number.isFinite(Date.parse(entry.manifest.captured_at)) && Date.parse(entry.manifest.captured_at) <= now)
      .sort((a, b) => (a.manifest.captured_at < b.manifest.captured_at ? 1 : -1));
    const newest = forDatabase[0];
    if (!newest) {
      report.push({ database, status: 'missing', age_hours: null });
      stale.push(`${database}: no backup found`);
      continue;
    }
    const ageMs = now - Date.parse(newest.manifest.captured_at);
    const ageHours = Math.round((ageMs / 3600000) * 10) / 10;
    const status = ageMs > maxAgeMs ? 'stale' : 'fresh';
    report.push({
      database,
      status,
      age_hours: ageHours,
      captured_at: newest.manifest.captured_at,
      bytes: newest.manifest.bytes,
      sha256: newest.manifest.sha256,
      rows: Object.values(newest.manifest.row_counts ?? {}).reduce((sum, count) => sum + count, 0),
      key: newest.key,
      backups: forDatabase.length,
    });
    if (status === 'stale') stale.push(`${database}: newest backup is ${ageHours}h old (limit ${maxAgeHours}h)`);
  }
  return { ok: stale.length === 0, stale, report };
}

export async function loadBackupManifests({ client, prefix = 'd1/' }) {
  const objects = await client.listObjects({ prefix });
  const manifestKeys = objects.filter(object => object.key.endsWith('.manifest.json')).map(object => object.key).sort();
  const entries = [];
  for (const key of manifestKeys) {
    const body = await client.getObject(key);
    if (!body) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(body);
    } catch {
      manifest = null;
    }
    entries.push({ key, size: objects.find(object => object.key === key)?.size ?? null, manifest, problems: manifest ? validateManifest(manifest) : ['manifest is not valid JSON'] });
  }
  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/backup/backup-status.mjs [--max-age-hours 30] [--json]');
    return;
  }
  const maxAgeIndex = args.indexOf('--max-age-hours');
  const maxAgeHours = maxAgeIndex === -1 ? DEFAULT_MAX_AGE_HOURS : Number(args[maxAgeIndex + 1]);
  const client = r2FromEnvironment();
  const manifests = await loadBackupManifests({ client });
  const { ok, stale, report } = assessFreshness({ databases: ['cflab', 'cflab-analytics', 'cflab-bitcoin-signals'], manifests, maxAgeHours });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok, max_age_hours: maxAgeHours, report, problems: manifests.filter(entry => entry.problems.length) }, null, 2));
  } else {
    console.log(`backup bucket: ${client.bucket} (${manifests.length} manifest(s), freshness limit ${maxAgeHours}h)`);
    for (const entry of report) {
      console.log(`${entry.status === 'fresh' ? 'OK   ' : 'FAIL '} ${entry.database}: ${entry.status}${entry.age_hours === null ? '' : ` (${entry.age_hours}h old)`}${entry.bytes ? `, ${entry.bytes} bytes, ${entry.rows} rows, ${entry.backups} stored backup(s)` : ''}`);
    }
    const malformed = manifests.filter(entry => entry.problems.length);
    for (const entry of malformed) console.log(`WARN  ${entry.key}: ${entry.problems.join('; ')}`);
  }
  if (!ok) {
    console.error(`FAIL: backup freshness check failed:\n- ${stale.join('\n- ')}`);
    process.exitCode = 1;
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
