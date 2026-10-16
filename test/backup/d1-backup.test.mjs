import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDumpSql, canonicalRowHash, orderTablesByDependencies, sqlLiteral,
  backupKeys, buildManifest, compactStamp, inspectExportSql, validateManifest, verifyArtifactAgainstManifest, verifyExport,
} from '../../scripts/backup/lib.mjs';
import { assessFreshness } from '../../scripts/backup/backup-status.mjs';
import { PRODUCTION_DATABASES, assertNotProductionTarget, databaseFor } from '../../scripts/backup/restore-verify.mjs';
import { DATABASES } from '../../scripts/backup/d1-export.mjs';

const TABLES = ['apps', 'd1_migrations', 'files'];
const LIVE = { apps: 4, d1_migrations: 10, files: 1325 };

function exportSql({ tables = TABLES, rows = { apps: 4, d1_migrations: 10, files: 1325 } } = {}) {
  const lines = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const table of tables) lines.push(`CREATE TABLE IF NOT EXISTS "${table}"(id TEXT);`);
  for (const [table, count] of Object.entries(rows)) {
    for (let index = 0; index < count; index += 1) lines.push(`INSERT INTO "${table}" ("id") VALUES(${index});`);
  }
  return lines.join('\n');
}

test('a complete export passes structural verification', () => {
  const result = verifyExport({ sql: exportSql(), expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.insertCounts.files, 1325);
  assert.equal(result.bytes > 0, true);
});

test('a truncated export is rejected', () => {
  const truncated = exportSql({ tables: TABLES.slice(0, 2) });
  const result = verifyExport({ sql: truncated, expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /missing tables: files/);
});

test('an export without rows for a non-empty table is rejected', () => {
  const result = verifyExport({ sql: exportSql({ rows: { d1_migrations: 10, apps: 4 } }), expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /no rows for "files" although the live database has 1325/);
});

test('an error document, a transaction, and an empty file are all rejected', () => {
  const asError = verifyExport({ sql: '{"error":{"text":"nope"}}', expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(asError.ok, false);
  assert.match(asError.problems.join(' '), /does not look like SQL/);

  const withTransaction = verifyExport({ sql: `BEGIN TRANSACTION;\n${exportSql()}`, expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(withTransaction.ok, false);
  assert.match(withTransaction.problems.join(' '), /does not start with SQL/);

  const empty = verifyExport({ sql: '-- nothing here', expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join(' '), /below the 1024-byte floor/);
});

test('rows for an unknown table are rejected while sqlite_sequence is tolerated', () => {
  const withUnknown = `${exportSql()}\nINSERT INTO "mystery" ("id") VALUES(1);`;
  const rejected = verifyExport({ sql: withUnknown, expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(' '), /unknown tables: mystery/);

  const withInternal = `${exportSql()}\nINSERT INTO "sqlite_sequence" ("name") VALUES('apps');`;
  const accepted = verifyExport({ sql: withInternal, expectedTables: TABLES, liveCounts: LIVE });
  assert.equal(accepted.ok, true, accepted.problems.join('; '));
  assert.deepEqual(accepted.internalRowCounts, { sqlite_sequence: 1 });
  assert.equal(accepted.insertCounts.sqlite_sequence, undefined);
});

test('the inspector handles the export mix of quoted and unquoted identifiers', () => {
  const inspection = inspectExportSql('CREATE TABLE IF NOT EXISTS "d1_migrations"(\nid TEXT);\nCREATE TABLE apps (\nid TEXT);\nINSERT INTO apps ("id") VALUES(1);');
  assert.deepEqual(inspection.tables, ['apps', 'd1_migrations']);
  assert.equal(inspection.insertCounts.get('apps'), 1);
});

test('backup keys are date-stamped, unique, and never reuse a stamp', () => {
  const first = backupKeys({ database: 'cflab', stamp: '20261016T031500Z' });
  const second = backupKeys({ database: 'cflab', stamp: '20261016T031501Z' });
  assert.equal(first.sql, 'd1/cflab/2026-10-16/cflab-20261016T031500Z.sql');
  assert.equal(first.manifest, 'd1/cflab/2026-10-16/cflab-20261016T031500Z.manifest.json');
  assert.notEqual(first.sql, second.sql);
  assert.equal(compactStamp(new Date('2026-10-16T03:15:00.000Z')), '20261016T031500Z');
});

test('manifests are validated strictly', () => {
  const good = buildManifest({
    database: 'cflab', databaseId: 'id', capturedAt: '2026-10-16T03:15:00.000Z', stamp: '20261016T031500Z',
    format: 'sql', file: 'cflab.sql', bytes: 10, sha256: 'a'.repeat(64), tables: TABLES, rowCounts: LIVE,
    source: 'wrangler d1 export DB --remote', tool: 'wrangler', toolVersion: '4.135.0', gitRevision: 'abc',
  });
  assert.deepEqual(validateManifest(good), []);
  assert.match(validateManifest({ ...good, sha256: 'nothex' }).join(' '), /not a SHA-256 hex digest/);
  assert.match(validateManifest({ ...good, bytes: 0 }).join(' '), /non-positive size/);
  assert.match(validateManifest({ ...good, captured_at: 'yesterday' }).join(' '), /not a timestamp/);
  assert.match(validateManifest({ ...good, database: undefined }).join(' '), /missing database/);
  assert.match(validateManifest(null).join(' '), /not an object/);
});

test('an artifact that does not match its manifest is rejected', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'cflab-manifest-'));
  const file = path.join(dir, 'cflab.sql');
  writeFileSync(file, 'PRAGMA defer_foreign_keys=TRUE;\n');
  const manifest = { bytes: 29, sha256: 'b'.repeat(64) };
  const problems = await verifyArtifactAgainstManifest(manifest, file);
  assert.match(problems.join(' '), /artifact sha256/);
  const missing = await verifyArtifactAgainstManifest(manifest, path.join(dir, 'absent.sql'));
  assert.match(missing.join(' '), /unreadable/);
});

test('freshness distinguishes fresh, stale, and missing backups', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const manifest = captured => ({ schema_version: 1, kind: 'd1-export', database: 'cflab', captured_at: captured, format: 'sql', file: 'f', bytes: 1, sha256: 'a'.repeat(64), tables: [], row_counts: {} });
  const fresh = assessFreshness({ databases: ['cflab'], manifests: [{ key: 'k', manifest: manifest('2026-10-16T03:00:00.000Z') }], now, maxAgeHours: 30 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.report[0].status, 'fresh');
  assert.equal(fresh.report[0].age_hours, 9);

  const stale = assessFreshness({ databases: ['cflab'], manifests: [{ key: 'k', manifest: manifest('2026-10-14T03:00:00.000Z') }], now, maxAgeHours: 30 });
  assert.equal(stale.ok, false);
  assert.equal(stale.report[0].status, 'stale');
  assert.match(stale.stale[0], /newest backup is 57h old \(limit 30h\)/);

  const missing = assessFreshness({ databases: ['cflab', 'cflab-analytics'], manifests: [], now, maxAgeHours: 30 });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.report.map(entry => entry.status), ['missing', 'missing']);
});

test('freshness uses the newest manifest per database and counts the stored set', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const entry = (captured, bytes) => ({ key: `k-${captured}`, manifest: { database: 'cflab', captured_at: captured, bytes, row_counts: { apps: 4 } } });
  const result = assessFreshness({
    databases: ['cflab'], now, maxAgeHours: 30,
    manifests: [entry('2026-10-16T03:00:00.000Z', 100), entry('2026-10-15T03:00:00.000Z', 90)],
  });
  assert.equal(result.report[0].bytes, 100);
  assert.equal(result.report[0].backups, 2);
  assert.equal(result.report[0].rows, 4);
});

test('a restore can never target a production database', () => {
  for (const target of PRODUCTION_DATABASES) {
    assert.throws(() => assertNotProductionTarget(target), /refusing to restore into the production database/);
  }
  assert.doesNotThrow(() => assertNotProductionTarget('cflab-restore-20261016'));
  assert.throws(() => databaseFor('nope'), /unknown database label/);
  assert.equal(databaseFor('cflab').localConfig, 'wrangler.local.jsonc');
});

test('the backup tooling targets the documented production databases', () => {
  assert.deepEqual(DATABASES.map(database => database.label), ['cflab', 'cflab-analytics']);
  assert.deepEqual(DATABASES.map(database => database.databaseId), ['cb2d2eb4-2817-4581-8e50-d69212650adf', '54e8af8e-3345-40e7-88fd-462a688421b5']);
  for (const database of DATABASES) {
    assert.ok(database.config.endsWith('.jsonc') && database.localConfig.includes('local'), `${database.label} needs both configs`);
  }
});

test('SQL literals encode every value type safely', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(-1.5), '-1.5');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(false), '0');
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("a'b'c"), "'a''b''c'");
  assert.equal(sqlLiteral({ a: 1 }), `'{"a":1}'`);
  assert.equal(sqlLiteral('line\nbreak'), "'line\nbreak'");
});

test('a dump is a faithful, import-safe SQL file', () => {
  const sql = buildDumpSql({
    schema: [
      { type: 'index', name: 'files_by_record', sql: 'CREATE INDEX files_by_record ON files(app_id)' },
      { type: 'table', name: 'files', sql: 'CREATE TABLE files (id TEXT, filename TEXT)' },
    ],
    rowsByTable: { files: [{ id: 'a', filename: "O'Brien.jpg" }, { id: 'b', filename: null }] },
  });
  assert.ok(sql.startsWith('PRAGMA defer_foreign_keys=TRUE;\n'));
  assert.ok(sql.indexOf('CREATE TABLE files') < sql.indexOf('CREATE INDEX files_by_record'), 'tables are created before their indexes');
  assert.match(sql, /INSERT INTO "files" \("id","filename"\) VALUES\('a','O''Brien\.jpg'\);/);
  assert.match(sql, /INSERT INTO "files" \("id","filename"\) VALUES\('b',NULL\);/);
  assert.doesNotMatch(sql, /BEGIN TRANSACTION|COMMIT/);
});

test('tables are ordered parents-before-children so a dump imports in auto-commit', () => {
  const schema = [
    { type: 'table', name: 'password_reset_tokens', sql: 'CREATE TABLE password_reset_tokens (id TEXT, user_id TEXT REFERENCES "users"(id))' },
    { type: 'table', name: 'users', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
    { type: 'table', name: 'files', sql: 'CREATE TABLE files (id TEXT, record_id TEXT REFERENCES records(id))' },
    { type: 'table', name: 'records', sql: 'CREATE TABLE records (id TEXT PRIMARY KEY)' },
    { type: 'index', name: 'files_by_record', sql: 'CREATE INDEX files_by_record ON files(record_id)' },
  ];
  const { ordered, cycles } = orderTablesByDependencies(schema);
  assert.deepEqual(cycles, [], 'no cycles in this schema');
  assert.ok(ordered.indexOf('users') < ordered.indexOf('password_reset_tokens'), 'users precedes its dependent table');
  assert.ok(ordered.indexOf('records') < ordered.indexOf('files'), 'records precedes its dependent table');

  const sql = buildDumpSql({ schema, rowsByTable: { users: [{ id: 'u1' }], password_reset_tokens: [{ id: 'p1', user_id: 'u1' }] } });
  assert.ok(sql.indexOf('CREATE TABLE users') < sql.indexOf("INSERT INTO \"users\""), 'a table is created before its rows');
  assert.ok(sql.indexOf("INSERT INTO \"users\"") < sql.indexOf('CREATE TABLE password_reset_tokens'), 'the parent rows are inserted before the child table is created');
  assert.ok(sql.indexOf('CREATE TABLE password_reset_tokens') < sql.indexOf('CREATE INDEX files_by_record'), 'indexes come after the data');
});

test('a self-reference or an unknown reference does not break ordering', () => {
  const schema = [
    { type: 'table', name: 'nodes', sql: 'CREATE TABLE nodes (id TEXT PRIMARY KEY, parent TEXT REFERENCES nodes(id))' },
    { type: 'table', name: 'orphans', sql: 'CREATE TABLE orphans (id TEXT, other TEXT REFERENCES vanished(id))' },
  ];
  const { ordered, cycles } = orderTablesByDependencies(schema);
  assert.deepEqual(cycles, []);
  assert.deepEqual([...ordered].sort(), ['nodes', 'orphans']);
});

test('internal bookkeeping rows are dumped last', () => {
  const sql = buildDumpSql({
    schema: [{ type: 'table', name: 'records', sql: 'CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT)' }],
    rowsByTable: { records: [{ id: 4 }] },
    internalRowsByTable: { sqlite_sequence: [{ name: 'records', seq: 4 }] },
  });
  assert.ok(sql.indexOf("INSERT INTO \"records\"") < sql.indexOf('INSERT INTO "sqlite_sequence"'), 'the sequence counter is restored after the rows');
  assert.match(sql, /INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES\('records',4\);/);
});

test('row hashes are order-independent and detect any data change', () => {
  const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
  assert.equal(canonicalRowHash(rows), canonicalRowHash([{ id: 'b', n: 2 }, { id: 'a', n: 1 }]));
  assert.equal(canonicalRowHash(rows), canonicalRowHash([{ n: 1, id: 'a' }, { n: 2, id: 'b' }]));
  assert.notEqual(canonicalRowHash(rows), canonicalRowHash([{ id: 'a', n: 1 }, { id: 'b', n: 3 }]));
  assert.notEqual(canonicalRowHash(rows), canonicalRowHash([{ id: 'a', n: 1 }]));
});
