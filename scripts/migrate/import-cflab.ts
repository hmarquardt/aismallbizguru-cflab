#!/usr/bin/env node
// Dry-run-first CFLab importer. Reads a private LabBox snapshot and plans or applies
// deterministic inserts into CFLab D1 and R2. Default mode performs no mutation.
// Usage:
//   node scripts/migrate/import-cflab.ts --snapshot .migration/snapshots/<id> [--execute] [--local] [--update]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildImportPlan, cflabObjectKey, sha256Hex, appInsertSql, fileInsertSql, recordInsertSql,
  type ExistingState, type Snapshot,
} from './lib.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const snapshotDir = arg('snapshot');
if (!snapshotDir) { console.error('usage: import-cflab.ts --snapshot <dir> [--execute] [--local] [--update] [--verify-files none|sample|all] [--report-dir dir]'); process.exit(1); }
const execute = process.argv.includes('--execute');
const local = process.argv.includes('--local');
const update = process.argv.includes('--update');
const verifyMode = arg('verify-files') ?? 'sample';
const reportDir = arg('report-dir') ?? 'migration-reports';
const config = arg('config') ?? (local ? 'wrangler.local.jsonc' : 'wrangler.jsonc');
const bucket = arg('bucket') ?? 'cflab-files';
const accountId = arg('account-id') ?? 'b1aa310aa0a1638d72b8b086a21e557c';
const apiTokenFile = arg('api-token-file');
const apiToken = apiTokenFile ? readFileSync(apiTokenFile, 'utf8').trim() : process.env.CF_API_TOKEN ?? null;

const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as Snapshot;
if (!snapshot.manifest.files.complete && !process.argv.includes('--allow-missing-files')) {
  console.error(`snapshot files incomplete (missing ${snapshot.manifest.files.missing.length}); refusing to import`);
  process.exit(1);
}

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function d1Query(sql: string): Array<Record<string, unknown>> {
  const output = wrangler(['d1', 'execute', 'DB', '--config', config, ...(local ? ['--local'] : ['--remote']), '--json', '--command', sql]);
  const parsed = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}
const existing: ExistingState = { apps: new Map(), records: new Map(), files: new Map() };
for (const row of d1Query('SELECT id, name, active FROM apps')) existing.apps.set(String(row.id), { name: String(row.name), active: Number(row.active) === 1, origins: new Set() });
for (const row of d1Query('SELECT app_id, origin FROM app_origins')) existing.apps.get(String(row.app_id))?.origins.add(String(row.origin));
for (const row of d1Query('SELECT app_id, resource, id, data_json, created_at, updated_at FROM records')) {
  existing.records.set(`${row.app_id}/${row.resource}/${row.id}`, { data_json: String(row.data_json), created_at: String(row.created_at), updated_at: String(row.updated_at) });
}
for (const row of d1Query('SELECT id, app_id, size_bytes, checksum FROM files')) {
  existing.files.set(String(row.id), { size_bytes: Number(row.size_bytes), checksum: row.checksum == null ? null : String(row.checksum) });
}

const plan = buildImportPlan(snapshot, existing, update);
const summary = {
  mode: execute ? 'execute' : 'dry-run',
  target: local ? 'local' : 'remote',
  snapshot_id: snapshot.manifest.snapshot_id,
  source: snapshot.manifest.source,
  apps_to_create: plan.appsToCreate.length,
  app_conflicts: plan.appConflicts.length,
  records_insert: plan.records.insert.length,
  records_present: plan.records.present.length,
  records_conflicts: plan.records.conflicts.length,
  records_malformed: plan.records.malformed.length,
  files_insert: plan.files.insert.length,
  files_present: plan.files.present.length,
  files_conflicts: plan.files.conflicts.length,
  files_malformed: plan.files.malformed.length,
  orphan_files: plan.files.orphans.length,
  transforms: plan.transforms.length,
  bytes_to_copy: plan.bytesToCopy,
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `${snapshot.manifest.snapshot_id}-${summary.mode}${local ? '-local' : ''}.json`);
if (!execute) {
  writeFileSync(reportPath, JSON.stringify({ ...summary, plan_examples: { conflicts: plan.records.conflicts.slice(0, 20), malformed: plan.records.malformed.slice(0, 20), orphans: plan.files.orphans.slice(0, 20), app_conflicts: plan.appConflicts } }, null, 2));
  console.log(`dry run only; report written to ${reportPath}`);
  process.exit(0);
}
if (plan.records.conflicts.length || plan.files.conflicts.length || plan.appConflicts.length) {
  console.error('refusing to execute with unresolved conflicts; resolve migration logic or pass --update deliberately');
  writeFileSync(reportPath, JSON.stringify({ ...summary, error: 'unresolved conflicts' }, null, 2));
  process.exit(1);
}

const scratch = join(dirname(snapshotDir), 'sql');
mkdirSync(scratch, { recursive: true });
function runSql(label: string, statements: string[]): void {
  if (!statements.length) return;
  const file = join(scratch, `${label}.sql`);
  writeFileSync(file, statements.join('\n') + '\n');
  console.log(`applying ${label}: ${statements.length} statements`);
  wrangler(['d1', 'execute', 'DB', '--config', config, ...(local ? ['--local'] : ['--remote']), '--file', file]);
}
runSql('apps', plan.appsToCreate.flatMap(app => appInsertSql(app.id, app.name, app.origins)));
const recordStatements = plan.records.insert.map(({ record, dataJson }) => recordInsertSql(record, dataJson));
for (let i = 0; i < recordStatements.length; i += 200) runSql(`records-${i / 200}`, recordStatements.slice(i, i + 200));
const fileStatements = plan.files.insert.map(file => fileInsertSql(file));
for (let i = 0; i < fileStatements.length; i += 200) runSql(`files-${i / 200}`, fileStatements.slice(i, i + 200));

const hashIndex = JSON.parse(readFileSync(join(snapshotDir, 'files/hashes.json'), 'utf8')) as Record<string, { sha256: string; bytes: number; content_type: string }>;
let uploaded = 0;
let uploadedBytes = 0;
const failed: string[] = [];
const sampleTargets = plan.files.insert.length <= 5 || verifyMode === 'all'
  ? plan.files.insert
  : plan.files.insert.filter((_, index) => index < 5);
for (const file of plan.files.insert) {
  const key = cflabObjectKey(file.app_id, file.id);
  const bytes = new Uint8Array(readFileSync(join(snapshotDir, 'files/objects', file.id)));
  try {
    if (local) {
      if (sampleTargets.includes(file)) {
        const temp = join(scratch, `object-${file.id}`);
        writeFileSync(temp, bytes);
        wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', temp, '--local', '--config', config]);
        uploaded++; uploadedBytes += bytes.length;
      }
    } else {
      if (!apiToken) throw new Error('CF_API_TOKEN or --api-token-file required for remote R2 uploads');
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': file.content_type ?? 'application/octet-stream' },
        body: bytes,
      });
      const json = await response.json() as { success?: boolean; result?: { size?: string } };
      if (!response.ok || !json.success) throw new Error(`upload failed: status ${response.status}`);
      if (json.result?.size !== undefined && Number(json.result.size) !== bytes.length) throw new Error('uploaded size mismatch');
      uploaded++; uploadedBytes += bytes.length;
    }
  } catch (error) {
    failed.push(file.id);
    console.error(`  upload ${file.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

let hashVerified = 0;
let hashMismatch = 0;
if (!local && verifyMode !== 'none' && apiToken) {
  for (const file of sampleTargets) {
    const key = cflabObjectKey(file.app_id, file.id);
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expected = hashIndex[file.id]?.sha256;
      if (expected && sha256Hex(bytes) === expected) hashVerified++;
      else hashMismatch++;
    } catch (error) {
      hashMismatch++;
      console.error(`  verify ${file.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

const result = {
  ...summary,
  uploaded_files: uploaded,
  uploaded_bytes: uploadedBytes,
  upload_failed: failed.length,
  hash_verified: hashVerified,
  hash_mismatch: hashMismatch,
  verify_mode: local ? 'local-sample' : verifyMode,
};
writeFileSync(reportPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failed.length || hashMismatch) process.exit(1);
