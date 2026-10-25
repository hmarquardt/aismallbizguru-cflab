import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATABASES, dumpDatabase } from '../../scripts/backup/d1-export.mjs';
import { assertIsolatedRemoteConfig, PRODUCTION_DATABASES, restoreAndVerify } from '../../scripts/backup/restore-verify.mjs';
import { assessFreshness } from '../../scripts/backup/backup-status.mjs';
import { readConfig } from '../../scripts/ci/verify-deployment-target.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'bitcoin-audit-backup-'));
const result = rows => ({ status: 0, output: JSON.stringify([{ results: rows, success: true }]) });

test('backup manifests and restore protection follow the real Wrangler IDs', () => {
  for (const database of DATABASES) {
    const binding = readConfig(database.config).d1_databases.find(entry => entry.binding === database.binding);
    assert.equal(database.databaseId, binding.database_id);
    assert.equal(PRODUCTION_DATABASES.has(binding.database_id), true);
  }
});

test('a harmless alias cannot point a remote restore at a production database ID', () => {
  const config = path.join(dir, 'alias.json');
  for (const database of DATABASES) {
    writeFileSync(config, JSON.stringify({ d1_databases: [{ binding: 'TEMP', database_name: 'restore-audit', database_id: database.databaseId }] }));
    assert.throws(() => assertIsolatedRemoteConfig('TEMP', config), /production database/);
  }
});

test('a failed snapshot read never falls back to per-table production reads', () => {
  const calls = [];
  assert.throws(() => dumpDatabase(DATABASES[2], { run: args => {
    const sql = args.at(-1);
    calls.push(sql);
    if (sql.includes('sqlite_schema')) return result([
      { type: 'table', name: 'parent', sql: 'CREATE TABLE parent(id INTEGER PRIMARY KEY)' },
      { type: 'table', name: 'child', sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))' },
    ]);
    throw new Error('snapshot unavailable');
  } }), /snapshot unavailable/);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /SELECT \* FROM "parent"; SELECT \* FROM "child"/);
});

test('failed restore integrity rejects the operation instead of returning a successful CLI result', async () => {
  const sql = 'CREATE TABLE d1_migrations(id INTEGER);\nINSERT INTO d1_migrations VALUES(1);\n';
  writeFileSync(path.join(dir, 'backup.sql'), sql);
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, kind: 'd1-export', database: 'cflab-bitcoin-signals',
    captured_at: '2026-10-25T00:00:00.000Z', stamp: '20261025T000000Z', format: 'sql', file: 'backup.sql',
    bytes: Buffer.byteLength(sql), sha256: createHash('sha256').update(sql).digest('hex'), tables: ['d1_migrations'], row_counts: { d1_migrations: 1 } }));
  await assert.rejects(restoreAndVerify({ manifestPath, workDir: dir, run: args => {
    const sql = args[args.indexOf('--command') + 1];
    if (!args.includes('--command')) return result([]);
    if (sql.includes('sqlite_schema')) return result([{ name: 'd1_migrations' }]);
    if (sql.includes('COUNT')) return result([{ n: 1 }]);
    if (sql === 'PRAGMA quick_check') return result([{ quick_check: 'corrupt' }]);
    return result([]);
  } }), /restore verification failed.*\n- PRAGMA quick_check reported "corrupt"/);
});

test('malformed and future backup manifests cannot report fresh', () => {
  const now = Date.parse('2026-10-25T12:00:00.000Z');
  for (const entry of [
    { manifest: { database: 'cflab-bitcoin-signals', captured_at: '2026-10-25T11:00:00.000Z' }, problems: ['invalid hash'] },
    { manifest: { database: 'cflab-bitcoin-signals', captured_at: '2026-10-26T11:00:00.000Z' } },
  ]) {
    assert.equal(assessFreshness({ databases: ['cflab-bitcoin-signals'], manifests: [entry], now }).ok, false);
  }
});
