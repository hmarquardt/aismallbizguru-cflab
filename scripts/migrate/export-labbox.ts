#!/usr/bin/env node
// GET-only LabBox exporter. Writes a private snapshot under .migration/ (gitignored).
// Usage:
//   node scripts/migrate/export-labbox.ts --out .migration/snapshots/<id> [--token-file <path>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_APP_MAP, DEFAULT_BASE_URL, DEFAULT_DATASETS, assertGetOnly, collectComplete, redactUrl,
  validateRecord, verifyFileBytes, type LegacyFile, type LegacyRecord,
  type Snapshot, type SnapshotManifest,
} from './lib.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const outDir = arg('out');
if (!outDir) { console.error('usage: export-labbox.ts --out <dir> [--base-url url] [--token-file path] [--skip-files]'); process.exit(1); }
const baseUrl = arg('base-url') ?? DEFAULT_BASE_URL;
const tokenFile = arg('token-file');
const skipFiles = process.argv.includes('--skip-files');
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null;
const snapshotId = outDir.split('/').filter(Boolean).pop() ?? new Date().toISOString();
const startedAt = new Date().toISOString();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function labboxGet(path: string, authorized: boolean): Promise<Response> {
  assertGetOnly('GET');
  const headers: Record<string, string> = { Accept: 'application/json, */*' };
  if (authorized) {
    if (!token) throw new Error(`read credential required for ${redactUrl(path)}`);
    headers.Authorization = `Bearer ${token}`;
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (response.status >= 500 && attempt < 3) { lastError = new Error(`status ${response.status}`); await sleep(500 * attempt); continue; }
      return response;
    } catch (error) { lastError = error; await sleep(500 * attempt); }
  }
  throw new Error(`GET ${redactUrl(path)} failed: ${lastError instanceof Error ? lastError.message : 'unknown'}`);
}
async function getJson(path: string, authorized: boolean): Promise<unknown> {
  const response = await labboxGet(path, authorized);
  if (!response.ok) throw new Error(`GET ${redactUrl(path)} -> status ${response.status}`);
  return await response.json();
}

const registry = await getJson('/api/apps', false) as { apps?: Record<string, { auth?: { default_read?: string } }> };
const publicApps = new Set(Object.entries(registry.apps ?? {}).filter(([, config]) => config.auth?.default_read === 'public').map(([id]) => id));

const records: LegacyRecord[] = [];
const datasets: SnapshotManifest['datasets'] = [];
let rejectedRecords = 0;
for (const dataset of DEFAULT_DATASETS) {
  const authorized = !publicApps.has(dataset.app);
  const label = `${dataset.app}/${dataset.resource}`;
  try {
    const { items, pages } = await collectComplete<LegacyRecord>(label, async () => {
      const json = await getJson(`/api/${dataset.app}/${dataset.resource}`, authorized) as { records?: LegacyRecord[]; total?: number };
      const list = Array.isArray(json.records) ? json.records : [];
      return { items: list, total: typeof json.total === 'number' ? json.total : undefined };
    });
    let rejected = 0;
    for (const record of items) {
      const problems = validateRecord(record);
      if (problems.length) { rejected++; console.error(`  rejected ${label}/${(record as { id?: string }).id ?? '?'}: ${problems.join(', ')}`); continue; }
      records.push(record);
    }
    rejectedRecords += rejected;
    datasets.push({ app: dataset.app, resource: dataset.resource, total: items.length, exported: items.length - rejected, complete: rejected === 0 });
    console.log(`${label.padEnd(42)} exported=${items.length - rejected} pages=${pages}${rejected ? ` rejected=${rejected}` : ''}`);
  } catch (error) {
    datasets.push({ app: dataset.app, resource: dataset.resource, total: null, exported: 0, complete: false });
    console.error(`${label.padEnd(42)} FAILED: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  }
}

const fileMap = new Map<string, LegacyFile>();
for (const record of records) for (const file of record.files ?? []) if (!fileMap.has(file.id)) fileMap.set(file.id, file);
const files = [...fileMap.values()].sort((a, b) => a.id.localeCompare(b.id));
const missing: string[] = [];
const hashes: Record<string, { sha256: string; bytes: number; content_type: string }> = {};
let downloaded = 0;
let bytesDownloaded = 0;
if (!skipFiles) {
  mkdirSync(join(outDir, 'files/objects'), { recursive: true });
  const concurrency = Math.max(1, Math.min(8, Number(arg('concurrency') ?? '5')));
  let cursor = 0;
  let finished = 0;
  const downloadOne = async (file: LegacyFile): Promise<void> => {
    const target = join(outDir, 'files/objects', file.id);
    try {
      if (existsSync(target)) {
        const existing = new Uint8Array(readFileSync(target));
        const check = verifyFileBytes(existing, file);
        if (check.ok) { hashes[file.id] = { sha256: check.sha256, bytes: existing.length, content_type: file.content_type ?? 'application/octet-stream' }; downloaded++; bytesDownloaded += existing.length; return; }
      }
      const authorized = !publicApps.has(file.app_id);
      let path = `/api/files/${file.id}`;
      if (file.url) {
        const parsed = new URL(file.url, baseUrl);
        if (parsed.origin !== new URL(baseUrl).origin) throw new Error(`unexpected file host ${parsed.origin}`);
        path = `${parsed.pathname}${parsed.search}`;
      }
      const response = await labboxGet(path, authorized);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const check = verifyFileBytes(bytes, file);
      if (!check.ok) throw new Error(`verification failed (size_ok=${check.sizeOk}, checksum_ok=${check.checksumOk})`);
      writeFileSync(target, bytes);
      hashes[file.id] = { sha256: check.sha256, bytes: bytes.length, content_type: file.content_type ?? 'application/octet-stream' };
      downloaded++; bytesDownloaded += bytes.length;
    } catch (error) {
      missing.push(file.id);
      console.error(`  file ${file.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  };
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      await downloadOne(file);
      if (++finished % 100 === 0) console.error(`  files ${finished}/${files.length} (${(bytesDownloaded / 1048576).toFixed(1)} MiB)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

const manifest: SnapshotManifest = {
  snapshot_id: snapshotId,
  source: 'live LabBox read API',
  base_url: baseUrl,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  datasets,
  files: { referenced: files.length, downloaded, bytes: bytesDownloaded, missing, complete: skipFiles ? false : missing.length === 0 },
  rejected_records: rejectedRecords,
  app_map: DEFAULT_APP_MAP,
};
const snapshot: Snapshot = { manifest, records, files };
mkdirSync(join(outDir, 'records'), { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(outDir, 'records/all.json'), JSON.stringify(records));
writeFileSync(join(outDir, 'files/meta.json'), JSON.stringify(files));
writeFileSync(join(outDir, 'files/hashes.json'), JSON.stringify(hashes, null, 2));
writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot));
console.log(`snapshot ${snapshotId}: records=${records.length} files=${files.length} downloaded=${downloaded} bytes=${bytesDownloaded} missing=${missing.length}`);
if (missing.length || datasets.some(dataset => !dataset.complete)) process.exitCode = process.exitCode || 2;
