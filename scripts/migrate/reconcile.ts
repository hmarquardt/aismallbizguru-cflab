#!/usr/bin/env node
// Source-to-destination reconciliation and snapshot delta reporting.
// Usage:
//   node scripts/migrate/reconcile.ts --snapshot <dir> [--local] [--report-dir dir]
//   node scripts/migrate/reconcile.ts --snapshot <new> --compare <old> [--report-dir dir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffSnapshots, type Snapshot } from './lib.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const snapshotDir = arg('snapshot');
if (!snapshotDir) { console.error('usage: reconcile.ts --snapshot <dir> [--compare <older-dir>] [--local] [--report-dir dir]'); process.exit(1); }
const local = process.argv.includes('--local');
const reportDir = arg('report-dir') ?? 'migration-reports';
const config = arg('config') ?? (local ? 'wrangler.local.jsonc' : 'wrangler.jsonc');
const compareDir = arg('compare');
const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as Snapshot;

if (compareDir) {
  const previous = JSON.parse(readFileSync(join(compareDir, 'snapshot.json'), 'utf8')) as Snapshot;
  const delta = diffSnapshots(previous, snapshot);
  const report = { mode: 'delta', baseline: previous.manifest.snapshot_id, current: snapshot.manifest.snapshot_id, ...delta };
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, `${snapshot.manifest.snapshot_id}-delta.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function d1Query(sql: string): Array<Record<string, unknown>> {
  const output = wrangler(['d1', 'execute', 'DB', '--config', config, ...(local ? ['--local'] : ['--remote']), '--json', '--command', sql]);
  return (JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>)[0]?.results ?? [];
}

const sourceByDataset = new Map<string, number>();
for (const record of snapshot.records) {
  const key = `${record.app_id}/${record.resource}`;
  sourceByDataset.set(key, (sourceByDataset.get(key) ?? 0) + 1);
}
const destinationByDataset = new Map<string, number>();
for (const row of d1Query('SELECT app_id, resource, COUNT(*) AS n FROM records GROUP BY app_id, resource')) {
  destinationByDataset.set(`${row.app_id}/${row.resource}`, Number(row.n));
}
const datasetResults = [...new Set([...sourceByDataset.keys(), ...destinationByDataset.keys()])].sort().map(key => {
  const source = sourceByDataset.get(key) ?? 0;
  const destination = destinationByDataset.get(key) ?? 0;
  return { dataset: key, source, destination, match: source === destination, difference: destination - source };
});

const sourceFiles = snapshot.files.length;
const sourceBytes = snapshot.files.reduce((total, file) => total + (file.size_bytes ?? 0), 0);
const fileRow = d1Query('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM files')[0] ?? {};
const destinationFiles = Number(fileRow.n ?? 0);
const destinationBytes = Number(fileRow.bytes ?? 0);

const report = {
  mode: 'reconciliation',
  target: local ? 'local' : 'remote',
  snapshot_id: snapshot.manifest.snapshot_id,
  snapshot_completed_at: snapshot.manifest.completed_at,
  datasets: datasetResults,
  records: {
    source: snapshot.records.length,
    destination: datasetResults.reduce((total, row) => total + row.destination, 0),
    match: datasetResults.every(row => row.match),
  },
  files: {
    source_metadata: sourceFiles,
    destination_metadata: destinationFiles,
    source_bytes: sourceBytes,
    destination_bytes: destinationBytes,
    match: sourceFiles === destinationFiles && sourceBytes === destinationBytes,
  },
  relationship: {
    source_linked: snapshot.files.filter(file => file.record_id).length,
    destination_linked: Number(d1Query('SELECT COUNT(*) AS n FROM files WHERE record_id IS NOT NULL')[0]?.n ?? 0),
  },
  orphan_files: snapshot.files.filter(file => file.record_id && !snapshot.records.some(record => record.id === file.record_id)).length,
  soft_deleted: 'not observable through the live read API; recoverable later from the encrypted Restic archive',
};
mkdirSync(reportDir, { recursive: true });
const path = join(reportDir, `${snapshot.manifest.snapshot_id}-reconciliation${local ? '-local' : ''}.json`);
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.records.match || !report.files.match) process.exit(1);
