#!/usr/bin/env node
// Capture a verified logical backup of each production D1 database.
//
// For every database this script:
//   1. reads the live table list and row counts with read-only queries;
//   2. runs `wrangler d1 export --remote` into a date-stamped local file;
//   3. verifies the export structurally (table set, rows for every non-empty
//      table, migration ledger, no transaction statements, not an error page);
//   4. hashes it and writes a manifest next to it.
//
// It never overwrites an existing artifact, never writes to a production
// database, and never logs row contents. Restoring the export into an isolated
// database is a separate step (scripts/backup/restore-verify.mjs) so a backup is
// only declared good after a restore has actually succeeded.
//
// Usage: node scripts/backup/d1-export.mjs --out <dir> [--database DB|ANALYTICS|all]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  backupKeys, buildManifest, compactStamp, sha256File, verifyExport, wranglerResultSets, wranglerRows, writeJsonFile,
} from './lib.mjs';

export const DATABASES = [
  { binding: 'DB', label: 'cflab', databaseId: 'cb2d2eb4-2817-4581-8e50-d69212650adf', config: 'wrangler.jsonc', localConfig: 'wrangler.local.jsonc', minimumBytes: 4096 },
  { binding: 'ANALYTICS', label: 'cflab-analytics', databaseId: '54e8af8e-3345-40e7-88fd-462a688421b5', config: 'wrangler.analytics.jsonc', localConfig: 'wrangler.analytics.local.jsonc', minimumBytes: 1024 },
];

const TABLES_SQL = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";

export function wrangler(args, { allowFailure = false } = {}) {
  const binary = path.join('node_modules', '.bin', 'wrangler');
  if (!existsSync(binary)) throw new Error(`wrangler is not installed at ${binary}; run npm ci first`);
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`wrangler ${args.slice(0, 4).join(' ')} failed (exit ${result.status ?? 'unknown'}):\n${output.trim()}`);
  }
  return { status: result.status ?? 1, output };
}

// Read-only introspection. Every statement here is a SELECT, and both statements
// are batched so a backup costs two round trips per database.
export function liveState(database, { run = wrangler } = {}) {
  const tables = wranglerRows(run(['d1', 'execute', database.binding, '--remote', '--config', database.config, '--json', '--command', TABLES_SQL]).output)
    .map(row => row.name);
  if (!tables.length) return { tables, rowCounts: {} };
  const countsSql = tables.map(table => `SELECT COUNT(*) AS n FROM "${table}"`).join('; ');
  const sets = wranglerResultSets(run(['d1', 'execute', database.binding, '--remote', '--config', database.config, '--json', '--command', countsSql]).output);
  if (sets.length !== tables.length) throw new Error(`${database.label}: expected ${tables.length} count result sets, received ${sets.length}`);
  const rowCounts = {};
  tables.forEach((table, index) => { rowCounts[table] = Number(sets[index][0]?.n ?? 0); });
  return { tables, rowCounts };
}

export async function exportDatabase(database, { outDir, stamp = compactStamp(), run = wrangler, gitRevision, capturedAt = new Date().toISOString() } = {}) {
  mkdirSync(outDir, { recursive: true });
  const keys = backupKeys({ database: database.label, stamp });
  const sqlPath = path.join(outDir, path.basename(keys.sql));
  if (existsSync(sqlPath)) throw new Error(`refusing to overwrite an existing backup artifact: ${sqlPath}`);

  const { tables, rowCounts } = liveState(database, { run });
  if (!tables.length) throw new Error(`${database.label}: the live database reported no tables; refusing to export`);

  // wrangler writes the export itself and reports progress; only its exit status
  // and the resulting file are used, so no backup content is echoed into logs.
  const exported = run(['d1', 'export', database.binding, '--remote', '--config', database.config, '--output', sqlPath], { allowFailure: true });
  if (exported.status !== 0) throw new Error(`${database.label}: wrangler d1 export failed:\n${exported.output.trim()}`);
  if (!existsSync(sqlPath)) throw new Error(`${database.label}: wrangler reported success but wrote no file at ${sqlPath}`);

  const sql = readFileSync(sqlPath, 'utf8');
  const verification = verifyExport({ sql, expectedTables: tables, liveCounts: rowCounts, minimumBytes: database.minimumBytes });
  if (!verification.ok) {
    throw new Error(`${database.label}: export failed verification:\n- ${verification.problems.join('\n- ')}`);
  }
  // The export blocks concurrent requests, so it should never contain fewer rows
  // than the pre-export count. A shortfall means a partial export: fail closed.
  const shortfalls = Object.entries(rowCounts).filter(([table, count]) => (verification.insertCounts[table] ?? 0) < count);
  if (shortfalls.length) {
    throw new Error(`${database.label}: export has fewer rows than the live database for ${shortfalls.map(([table, count]) => `${table} (${verification.insertCounts[table] ?? 0} < ${count})`).join(', ')}`);
  }

  const bytes = Buffer.byteLength(sql, 'utf8');
  const sha256 = await sha256File(sqlPath);
  const manifest = buildManifest({
    database: database.label,
    databaseId: database.databaseId,
    capturedAt,
    stamp,
    format: 'sql',
    file: path.basename(keys.sql),
    bytes,
    sha256,
    tables: verification.tables,
    rowCounts: verification.insertCounts,
    source: `wrangler d1 export ${database.binding} --remote`,
    tool: 'wrangler',
    toolVersion: (run(['--version'], { allowFailure: true }).output.match(/\d+\.\d+\.\d+/) ?? [])[0] ?? 'unknown',
    gitRevision,
  });
  if (Object.keys(verification.internalRowCounts).length) manifest.internal_row_counts = verification.internalRowCounts;
  const manifestPath = path.join(outDir, path.basename(keys.manifest));
  writeJsonFile(manifestPath, manifest);
  writeFileSync(path.join(outDir, path.basename(keys.checksum)), `${sha256}  ${path.basename(keys.sql)}\n`);

  return { database: database.label, keys, sqlPath, manifestPath, manifest, verification };
}

function parseArgs(argv) {
  const options = { database: 'all', outDir: 'backups', stamp: compactStamp() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--out') { options.outDir = value; index += 1; }
    else if (flag === '--database') { options.database = value; index += 1; }
    else if (flag === '--stamp') { options.stamp = value; index += 1; }
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

const USAGE = 'Usage: node scripts/backup/d1-export.mjs --out <dir> [--database DB|ANALYTICS|all] [--stamp <YYYYMMDDTHHMMSSZ>]';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const selected = DATABASES.filter(database => options.database === 'all' || database.binding === options.database);
  if (!selected.length) throw new Error(`--database must be one of ${DATABASES.map(d => d.binding).join(', ')}, or all`);
  const results = [];
  for (const database of selected) {
    const result = await exportDatabase(database, { outDir: options.outDir, stamp: options.stamp, gitRevision: process.env.GITHUB_SHA });
    const rows = Object.values(result.manifest.row_counts).reduce((sum, count) => sum + count, 0);
    console.log(`OK    ${result.database}: ${result.verification.bytes} bytes, sha256 ${result.manifest.sha256.slice(0, 16)}…, ${result.manifest.tables.length} tables, ${rows} rows -> ${result.sqlPath}`);
    results.push(result);
  }
  writeJsonFile(path.join(options.outDir, `export-report-${options.stamp}.json`), {
    stamp: options.stamp,
    backups: results.map(result => ({
      database: result.database, keys: result.keys, bytes: result.manifest.bytes,
      sha256: result.manifest.sha256, tables: result.manifest.tables.length,
    })),
  });
  console.log(`OK    wrote ${results.length} backup(s) to ${options.outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
