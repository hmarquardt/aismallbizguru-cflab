#!/usr/bin/env node
// Throttled, retrying R2 sync and verification for a migration snapshot.
// Lists existing objects, uploads missing ones, and hash-verifies all objects.
// Usage: R2_API_TOKEN=... node scripts/migrate/sync-r2.ts --snapshot <dir> [--rps 3] [--verify all|sample|none]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cflabObjectKey, sha256Hex, type Snapshot } from './lib.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const snapshotDir = arg('snapshot');
if (!snapshotDir) { console.error('usage: sync-r2.ts --snapshot <dir> [--rps 3] [--verify all|sample|none] [--report-dir dir]'); process.exit(1); }
const accountId = arg('account-id') ?? 'b1aa310aa0a1638d72b8b086a21e557c';
const bucket = arg('bucket') ?? 'cflab-files';
const rps = Math.max(0.5, Number(arg('rps') ?? '3'));
const verifyMode = arg('verify') ?? 'all';
const reportDir = arg('report-dir') ?? 'migration-reports';
const token = process.env.R2_API_TOKEN ?? (arg('api-token-file') ? readFileSync(arg('api-token-file')!, 'utf8').trim() : null);
if (!token) { console.error('R2_API_TOKEN or --api-token-file required'); process.exit(1); }

const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as Snapshot;
const hashes = JSON.parse(readFileSync(join(snapshotDir, 'files/hashes.json'), 'utf8')) as Record<string, { sha256: string; bytes: number; content_type: string }>;
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const minInterval = 1000 / rps;
let lastRequest = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function apiFetch(url: string, init: RequestInit = {}, attempts = 6): Promise<Response> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = lastRequest + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(120_000) });
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`  rate limited (status ${response.status}); retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      continue;
    }
    return response;
  }
  throw new Error(`request failed after ${attempts} attempts: ${init.method ?? 'GET'} ${url.replace(base, '')}`);
}

const existing = new Set<string>();
let listCursor: string | null = null;
for (let page = 1; page <= 10; page++) {
  const response = await apiFetch(`${base}?per_page=1000${listCursor ? `&cursor=${encodeURIComponent(listCursor)}` : ''}`);
  if (!response.ok) throw new Error(`list failed: status ${response.status}`);
  const json = await response.json() as { result?: Array<{ key: string }>; result_info?: { cursor?: string } };
  const rows = json.result ?? [];
  for (const row of rows) existing.add(row.key);
  listCursor = json.result_info?.cursor ?? null;
  if (!listCursor || rows.length < 1000) break;
}
console.log(`existing R2 objects: ${existing.size}`);

const missing = snapshot.files.filter(file => !existing.has(cflabObjectKey(file.app_id, file.id)));
console.log(`snapshot objects: ${snapshot.files.length}; missing: ${missing.length}`);
let uploaded = 0;
let uploadedBytes = 0;
const failed: string[] = [];
for (const file of missing) {
  const key = cflabObjectKey(file.app_id, file.id);
  const bytes = new Uint8Array(readFileSync(join(snapshotDir, 'files/objects', file.id)));
  try {
    const response = await apiFetch(`${base}/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': file.content_type ?? 'application/octet-stream' }, body: bytes });
    const json = await response.json() as { success?: boolean };
    if (!response.ok || !json.success) throw new Error(`status ${response.status}`);
    uploaded++; uploadedBytes += bytes.length;
    if (uploaded % 100 === 0) console.log(`  uploaded ${uploaded}/${missing.length} (${(uploadedBytes / 1048576).toFixed(1)} MiB)`);
  } catch (error) {
    failed.push(file.id);
    console.error(`  upload ${file.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

const verifyTargets = verifyMode === 'none' ? [] : verifyMode === 'sample' ? snapshot.files.slice(0, 5) : snapshot.files;
let verified = 0;
let mismatch = 0;
for (const file of verifyTargets) {
  const key = cflabObjectKey(file.app_id, file.id);
  try {
    const response = await apiFetch(`${base}/${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256Hex(bytes) === hashes[file.id]?.sha256) { verified++; if (verified % 100 === 0) console.log(`  verified ${verified}/${verifyTargets.length}`); }
    else { mismatch++; console.error(`  hash mismatch: ${file.id}`); }
  } catch (error) {
    mismatch++;
    console.error(`  verify ${file.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
const report = {
  mode: 'r2-sync',
  snapshot_id: snapshot.manifest.snapshot_id,
  bucket,
  existing_before: existing.size,
  missing: missing.length,
  uploaded,
  uploaded_bytes: uploadedBytes,
  upload_failed: failed.length,
  verified,
  mismatch,
  verify_mode: verifyMode,
};
mkdirSync(reportDir, { recursive: true });
const path = join(reportDir, `${snapshot.manifest.snapshot_id}-r2-sync.json`);
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed.length || mismatch) process.exit(1);
