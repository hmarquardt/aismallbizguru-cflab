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
  backupKeys, buildDumpSql, buildManifest, canonicalRowHash, compactStamp, sha256File, verifyExport,
  wranglerResultSets, wranglerRows, writeJsonFile,
} from './lib.mjs';

export const DATABASES = [
  { binding: 'DB', label: 'cflab', databaseId: 'cb2d2eb4-2817-4581-8e50-d69212650adf', config: 'wrangler.jsonc', localConfig: 'wrangler.local.jsonc', minimumBytes: 4096 },
  { binding: 'ANALYTICS', label: 'cflab-analytics', databaseId: '54e8af8e-3345-40e7-88fd-462a688421b5', config: 'wrangler.analytics.jsonc', localConfig: 'wrangler.analytics.local.jsonc', minimumBytes: 1024 },
];

const TABLES_SQL = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";

export function wrangler(args, { allowFailure = false } = {}) {
  const binary = path.join('node_modules', '.bin', 'wrangler');
  if (!existsSync(binary)) throw new Error(`wrangler is not installed at ${binary}; run npm ci first`);
  // A whole-table SELECT is returned as one JSON document, which is far larger
  // than Node's 1 MiB spawnSync default. The cap is explicit so a table that
  // exceeds it fails loudly rather than being silently truncated.
  const maxBuffer = 256 * 1024 * 1024;
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    const code = result.error.code ?? 'unknown';
    throw new Error(`wrangler ${args.slice(0, 4).join(' ')} could not be read (${code}${code === 'ENOBUFS' ? `: output exceeded the ${maxBuffer}-byte read buffer; back up this table in chunks` : ''})`);
  }
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

const SCHEMA_SQL = "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name";

// A read-only logical dump: every statement is a SELECT, so the backup credential
// only needs D1 Read. `wrangler d1 export` is not usable for that: the export API
// requires D1 Write (it stages the SQL in Cloudflare's own R2 bucket), which would
// mean giving the backup job write access to production data.
export function dumpDatabase(database, { run = wrangler } = {}) {
  const schema = wranglerRows(run(['d1', 'execute', database.binding, '--remote', '--config', database.config, '--json', '--command', SCHEMA_SQL]).output)
    .map(row => ({ type: row.type, name: row.name, sql: String(row.sql) }));
  const tables = schema.filter(item => item.type === 'table').map(item => item.name);
  if (!tables.length) throw new Error(`${database.label}: the live database reported no tables; refusing to dump`);

  const rowsByTable = {};
  const rowCounts = {};
  const rowHashes = {};
  for (const table of tables) {
    const rows = wranglerRows(run(['d1', 'execute', database.binding, '--remote', '--config', database.config, '--json', '--command', `SELECT * FROM "${table}"`]).output);
    rowsByTable[table] = rows;
    rowCounts[table] = rows.length;
    rowHashes[table] = canonicalRowHash(rows);
  }
  return { schema, tables, rowsByTable, rowCounts, rowHashes, sql: buildDumpSql({ schema, rowsByTable }) };
}

export async function exportDatabase(database, { outDir, stamp = compactStamp(), run = wrangler, gitRevision, capturedAt = new Date().toISOString(), method = 'dump' } = {}) {
  mkdirSync(outDir, { recursive: true });
  const keys = backupKeys({ database: database.label, stamp });
  const sqlPath = path.join(outDir, path.basename(keys.sql));
  if (existsSync(sqlPath)) throw new Error(`refusing to overwrite an existing backup artifact: ${sqlPath}`);

  const { tables, rowCounts } = liveState(database, { run });
  if (!tables.length) throw new Error(`${database.label}: the live database reported no tables; refusing to backup`);

  let sql;
  let verification;
  let source;
  let rowHashes;
  if (method === 'dump') {
    // Default: read-only SELECT dump, so the backup credential needs D1 Read only.
    const dump = dumpDatabase(database, { run });
    sql = dump.sql;
    rowHashes = dump.rowHashes;
    verification = verifyExport({ sql, expectedTables: tables, liveCounts: dump.rowCounts, minimumBytes: database.minimumBytes });
    source = `read-only SELECT dump of ${database.binding}`;
  } else {
    // Alternative: the Cloudflare export API, which requires a write-capable token.
    const exported = run(['d1', 'export', database.binding, '--remote', '--config', database.config, '--output', sqlPath], { allowFailure: true });
    if (exported.status !== 0) throw new Error(`${database.label}: wrangler d1 export failed:\n${exported.output.trim()}`);
    if (!existsSync(sqlPath)) throw new Error(`${database.label}: wrangler reported success but wrote no file at ${sqlPath}`);
    sql = readFileSync(sqlPath, 'utf8');
    verification = verifyExport({ sql, expectedTables: tables, liveCounts: rowCounts, minimumBytes: database.minimumBytes });
    source = `wrangler d1 export ${database.binding} --remote`;
  }
  if (!verification.ok) {
    throw new Error(`${database.label}: backup failed verification:\n- ${verification.problems.join('\n- ')}`);
  }
  // The dump is read in one pass, so it must contain exactly the rows the live
  // database reported; a shortfall means a partial read: fail closed.
  const shortfalls = Object.entries(rowCounts).filter(([table, count]) => (verification.insertCounts[table] ?? 0) < count);
  if (shortfalls.length) {
    throw new Error(`${database.label}: backup has fewer rows than the live database for ${shortfalls.map(([table, count]) => `${table} (${verification.insertCounts[table] ?? 0} < ${count})`).join(', ')}`);
  }
  if (method === 'dump') writeFileSync(sqlPath, sql);

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
    source,
    tool: 'wrangler',
    toolVersion: (run(['--version'], { allowFailure: true }).output.match(/\d+\.\d+\.\d+/) ?? [])[0] ?? 'unknown',
    gitRevision,
  });
  if (method === 'dump') manifest.method = 'read-only-select';
  if (rowHashes) manifest.row_hashes = rowHashes;
  if (Object.keys(verification.internalRowCounts).length) manifest.internal_row_counts = verification.internalRowCounts;
  const manifestPath = path.join(outDir, path.basename(keys.manifest));
  writeJsonFile(manifestPath, manifest);
  writeFileSync(path.join(outDir, path.basename(keys.checksum)), `${sha256}  ${path.basename(keys.sql)}\n`);

  return { database: database.label, keys, sqlPath, manifestPath, manifest, verification };
}

function parseArgs(argv) {
  const options = { database: 'all', outDir: 'backups', stamp: compactStamp(), method: 'dump' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--out') { options.outDir = value; index += 1; }
    else if (flag === '--database') { options.database = value; index += 1; }
    else if (flag === '--stamp') { options.stamp = value; index += 1; }
    else if (flag === '--method') { options.method = value; index += 1; }
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!['dump', 'export'].includes(options.method)) throw new Error('--method must be dump (read-only SELECT, default) or export (requires a write-capable D1 token)');
  return options;
}

const USAGE = 'Usage: node scripts/backup/d1-export.mjs --out <dir> [--database DB|ANALYTICS|all] [--stamp <YYYYMMDDTHHMMSSZ>] [--method dump|export]';

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
    const result = await exportDatabase(database, { outDir: options.outDir, stamp: options.stamp, gitRevision: process.env.GITHUB_SHA, method: options.method });
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
