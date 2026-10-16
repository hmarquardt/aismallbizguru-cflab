// Shared helpers for the CFLab backup and restore tooling.
//
// Everything here is deliberately small and dependency-free: keys, hashing,
// manifest building, and the structural checks that let a backup be *verified*
// rather than assumed. Nothing in this module deletes anything, and nothing
// writes to a production database.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';

export const MANIFEST_SCHEMA_VERSION = 1;

// A compact, sortable, filename-safe UTC stamp: 20261016T031500Z.
export function compactStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Immutable-style, date-stamped keys. The stamp is part of the key, so a second
// run can never address the same key as an earlier one, and the day prefix makes
// lifecycle rules and prefix-scoped bucket locks straightforward.
export function backupKeys({ database, stamp = compactStamp() }) {
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const prefix = `d1/${database}/${day}/${database}-${stamp}`;
  return {
    prefix,
    sql: `${prefix}.sql`,
    checksum: `${prefix}.sql.sha256`,
    manifest: `${prefix}.manifest.json`,
  };
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// `wrangler d1 execute --json` prints a single-element array of result objects.
export function wranglerRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`wrangler did not return JSON: ${error.message}`);
  }
  const results = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(results)) throw new Error('wrangler JSON did not contain a results array');
  return results;
}

// A batched `--command` (statements separated by ';') returns one entry per
// statement, in order, which is how the introspection stays to two round trips.
export function wranglerResultSets(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`wrangler did not return JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('wrangler JSON was not an array of result sets');
  return parsed.map((entry, index) => {
    if (!Array.isArray(entry?.results)) throw new Error(`wrangler result set ${index} had no results array`);
    return entry.results;
  });
}

// Structural inspection of a `wrangler d1 export` SQL file. The export writes one
// `CREATE TABLE` per table and one `INSERT INTO` per row, and it mixes quoted and
// unquoted identifiers (system tables are quoted, user tables are not), so both
// forms are accepted here.
export function inspectExportSql(sql) {
  const tables = new Set();
  const insertCounts = new Map();
  for (const match of sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z0-9_]+)["`]?/gm)) tables.add(match[1]);
  for (const match of sql.matchAll(/^INSERT INTO ["`]?([A-Za-z0-9_]+)["`]?/gm)) insertCounts.set(match[1], (insertCounts.get(match[1]) ?? 0) + 1);
  return {
    tables: [...tables].sort(),
    insertCounts,
    firstLine: sql.split('\n', 1)[0]?.trim() ?? '',
    hasTransaction: /^\s*(BEGIN TRANSACTION|COMMIT)/m.test(sql),
    looksLikeError: /^\s*[[{]\s*"?(error|errors)"?/i.test(sql) || /^\s*<(!DOCTYPE|html)/i.test(sql),
  };
}

// Fails closed on anything that suggests a partial, truncated, or empty export.
export function verifyExport({ sql, expectedTables, liveCounts = {}, minimumBytes = 1024 }) {
  const problems = [];
  const inspection = inspectExportSql(sql);
  const bytes = Buffer.byteLength(sql, 'utf8');
  if (bytes < minimumBytes) problems.push(`export is only ${bytes} bytes, below the ${minimumBytes}-byte floor`);
  if (inspection.looksLikeError) problems.push('export does not look like SQL (an error document was written instead)');
  if (!/^(PRAGMA|CREATE TABLE|--)/.test(inspection.firstLine)) problems.push(`export does not start with SQL: "${inspection.firstLine.slice(0, 60)}"`);
  if (inspection.hasTransaction) problems.push('export contains BEGIN TRANSACTION/COMMIT, which D1 import rejects');
  if (!inspection.tables.length) problems.push('export contains no CREATE TABLE statements');

  const expected = [...expectedTables].sort();
  const missing = expected.filter(table => !inspection.tables.includes(table));
  const unexpected = inspection.tables.filter(table => !expected.includes(table));
  if (missing.length) problems.push(`export is missing tables: ${missing.join(', ')}`);
  if (unexpected.length) problems.push(`export contains tables the live database does not have: ${unexpected.join(', ')}`);

  // A table that holds rows live must carry rows in the export, otherwise the
  // export is partial even though it looks structurally complete.
  for (const [table, count] of Object.entries(liveCounts)) {
    if (count > 0 && !(inspection.insertCounts.get(table) > 0)) {
      problems.push(`export has no rows for "${table}" although the live database has ${count}`);
    }
  }
  if (!inspection.insertCounts.get('d1_migrations')) problems.push('export has no d1_migrations rows, so the migration ledger is missing');

  // Rows for a table the live database does not have are suspicious, except for
  // SQLite's own bookkeeping table, which is not part of the schema query.
  const internal = new Set(['sqlite_sequence']);
  const unexpectedInsertTargets = [...inspection.insertCounts.keys()].filter(table => !expected.includes(table) && !internal.has(table));
  if (unexpectedInsertTargets.length) problems.push(`export contains rows for unknown tables: ${unexpectedInsertTargets.join(', ')}`);

  const rowCounts = {};
  const internalRowCounts = {};
  for (const [table, count] of inspection.insertCounts) {
    if (expected.includes(table)) rowCounts[table] = count;
    else internalRowCounts[table] = count;
  }
  return { ok: problems.length === 0, problems, bytes, tables: inspection.tables, insertCounts: rowCounts, internalRowCounts };
}

export function buildManifest({ database, databaseId, capturedAt, stamp, format, file, bytes, sha256, tables, rowCounts, tool, toolVersion, gitRevision, source }) {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: 'd1-export',
    database,
    database_id: databaseId,
    captured_at: capturedAt,
    stamp,
    format,
    file,
    bytes,
    sha256,
    tables,
    row_counts: rowCounts,
    source,
    tool,
    tool_version: toolVersion,
    git_revision: gitRevision,
  };
}

export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) problems.push(`unexpected manifest schema_version: ${manifest.schema_version}`);
  for (const field of ['kind', 'database', 'captured_at', 'format', 'file', 'bytes', 'sha256', 'tables']) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') problems.push(`manifest is missing ${field}`);
  }
  if (typeof manifest.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(manifest.sha256)) problems.push('manifest sha256 is not a SHA-256 hex digest');
  if (typeof manifest.bytes === 'number' && manifest.bytes <= 0) problems.push('manifest records a non-positive size');
  if (manifest.captured_at && Number.isNaN(Date.parse(manifest.captured_at))) problems.push('manifest captured_at is not a timestamp');
  return problems;
}

// Compares a manifest with the artifact on disk: the file must exist, be the
// recorded size, and hash to the recorded digest.
export async function verifyArtifactAgainstManifest(manifest, path) {
  const problems = [];
  let bytes;
  try {
    bytes = readFileSync(path).length;
  } catch (error) {
    return [`artifact ${path} is unreadable: ${error.message}`];
  }
  if (manifest.bytes !== bytes) problems.push(`artifact is ${bytes} bytes but the manifest records ${manifest.bytes}`);
  const digest = await sha256File(path);
  if (digest !== manifest.sha256) problems.push(`artifact sha256 ${digest} does not match the manifest ${manifest.sha256}`);
  return problems;
}
