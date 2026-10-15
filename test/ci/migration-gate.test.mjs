import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  GateError, classifyMigration, classifyStatement, evaluatePending, loadApprovals,
  parsePendingMigrations, sha256, splitStatements,
} from '../../scripts/ci/migration-gate.mjs';

const APPROVALS = '.github/d1-migration-approvals.json';

test('additive statements are classified as safe', () => {
  const additive = [
    'CREATE TABLE things (id TEXT PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY)',
    'CREATE INDEX things_by_id ON things(id)',
    'CREATE INDEX IF NOT EXISTS things_by_id ON things(id)',
    'CREATE VIEW active_things AS SELECT * FROM things',
    "INSERT OR IGNORE INTO apps (id, name) VALUES ('x', 'X')",
    'ALTER TABLE things ADD COLUMN note TEXT',
    "ALTER TABLE things ADD COLUMN state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'old'))",
  ];
  for (const statement of additive) {
    assert.equal(classifyStatement(statement).verdict, 'additive-safe', statement);
  }
});

test('destructive statements are forbidden outright', () => {
  const forbidden = [
    'DROP TABLE things',
    'DROP INDEX things_by_id',
    'DELETE FROM things',
    'UPDATE things SET name = 1',
    'INSERT OR REPLACE INTO things (id) VALUES (1)',
    'REPLACE INTO things (id) VALUES (1)',
    'ALTER TABLE things DROP COLUMN note',
    'ALTER TABLE things RENAME TO other',
    'PRAGMA writable_schema = 1',
    'VACUUM',
  ];
  for (const statement of forbidden) {
    assert.equal(classifyStatement(statement).verdict, 'forbidden', statement);
  }
});

test('statements the gate cannot prove additive require approval', () => {
  const review = [
    'SELECT 1',
    'CREATE UNIQUE INDEX things_by_name ON things(name)',
    'CREATE TRIGGER touch AFTER UPDATE ON things BEGIN SELECT 1; END',
    'ALTER TABLE things ADD COLUMN code TEXT UNIQUE',
    'ALTER TABLE things ADD COLUMN code TEXT NOT NULL',
    "INSERT INTO things (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1",
  ];
  for (const statement of review) {
    assert.equal(classifyStatement(statement).verdict, 'requires-approval', statement);
  }
});

test('comments cannot hide a destructive statement', () => {
  assert.equal(classifyMigration('-- DROP TABLE things\nCREATE TABLE things (id TEXT)').verdict, 'additive-safe');
  assert.equal(classifyMigration('/* DELETE FROM things */ CREATE TABLE things (id TEXT)').verdict, 'additive-safe');
  assert.equal(classifyMigration('-- harmless\nDELETE FROM things').verdict, 'forbidden');
  assert.equal(classifyMigration('/* harmless */ DELETE FROM things').verdict, 'forbidden');
  assert.equal(classifyMigration("CREATE TABLE t (id TEXT) -- trailing\nDROP TABLE t").verdict, 'forbidden');
});

test('comments and string literals cannot hide, split, or corrupt a statement', () => {
  assert.deepEqual(splitStatements("SELECT '-- not a comment'"), ["SELECT '-- not a comment'"]);
  assert.deepEqual(splitStatements("INSERT OR IGNORE INTO t (id) VALUES ('a;b'); CREATE INDEX i ON t(id)"), [
    "INSERT OR IGNORE INTO t (id) VALUES ('a;b')",
    'CREATE INDEX i ON t(id)',
  ]);
  assert.equal(classifyMigration("INSERT OR IGNORE INTO t (id) VALUES ('x'); DROP TABLE t").verdict, 'forbidden');
});

test('a migration with no statements requires approval rather than passing silently', () => {
  const classification = classifyMigration('-- only a comment\n');
  assert.equal(classification.verdict, 'requires-approval');
  assert.deepEqual(classification.reasons, ['migration contains no statements']);
});

test('the pending migration table is parsed from wrangler output', () => {
  const output = [
    ' ⛅️ wrangler 4.135.0',
    'Resource location: remote ',
    '',
    'Migrations to be applied:',
    '┌───────────────────┐',
    '│ Name              │',
    '├───────────────────┤',
    '│ 0011_add_note.sql │',
    '│ 0012_add_index.sql │',
    '└───────────────────┘',
  ].join('\n');
  assert.deepEqual(parsePendingMigrations(output), ['0011_add_note.sql', '0012_add_index.sql']);
});

test('a database with no pending migrations is reported as empty', () => {
  assert.deepEqual(parsePendingMigrations('Resource location: remote \n\n✅ No migrations to apply!\n'), []);
});

test('an unreadable pending migration list fails closed instead of reporting nothing', () => {
  assert.throws(() => parsePendingMigrations('some unexpected wrangler failure'), GateError);
  assert.throws(() => parsePendingMigrations('Migrations to be applied:\n│ 0011_add_note.sql │ unexpected │'), GateError);
});

test('additive pending migrations do not need an approval', () => {
  const { entries, blocked } = evaluatePending({
    database: 'DB', pending: ['0011_add_note.sql'], migrationsDir: 'migrations', approvals: [],
    readFile: () => 'ALTER TABLE things ADD COLUMN note TEXT;',
  });
  assert.equal(blocked.length, 0);
  assert.equal(entries[0].verdict, 'additive-safe');
  assert.equal(entries[0].approved, false);
  assert.equal(entries[0].sha256, sha256('ALTER TABLE things ADD COLUMN note TEXT;'));
});

test('a destructive pending migration is blocked without an approval', () => {
  const { blocked } = evaluatePending({
    database: 'DB', pending: ['0011_drop.sql'], migrationsDir: 'migrations', approvals: [],
    readFile: () => 'DROP TABLE things;',
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].verdict, 'forbidden');
});

test('an approval only applies to the exact file content', () => {
  const sql = 'DROP INDEX things_by_id;';
  const approvals = [{ database: 'DB', file: '0011_drop.sql', sha256: sha256(sql), reason: 'reviewed' }];
  const approved = evaluatePending({ database: 'DB', pending: ['0011_drop.sql'], migrationsDir: 'migrations', approvals, readFile: () => sql });
  assert.equal(approved.blocked.length, 0);
  assert.equal(approved.entries[0].approved, true);

  const edited = evaluatePending({ database: 'DB', pending: ['0011_drop.sql'], migrationsDir: 'migrations', approvals, readFile: () => `${sql}\nDROP TABLE things;` });
  assert.equal(edited.blocked.length, 1);
  assert.equal(edited.entries[0].approved, false);
});

test('an approval for another database does not apply', () => {
  const sql = 'DELETE FROM things;';
  const approvals = [{ database: 'ANALYTICS', file: '0011_cleanup.sql', sha256: sha256(sql), reason: 'reviewed' }];
  const { blocked } = evaluatePending({ database: 'DB', pending: ['0011_cleanup.sql'], migrationsDir: 'migrations', approvals, readFile: () => sql });
  assert.equal(blocked.length, 1);
});

test('a pending migration missing from the checkout is blocked', () => {
  const { entries, blocked } = evaluatePending({
    database: 'DB', pending: ['0011_absent.sql'], migrationsDir: 'migrations', approvals: [],
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(entries[0].verdict, 'missing');
  assert.equal(blocked.length, 1);
});

test('the approvals file is read strictly', () => {
  assert.deepEqual(loadApprovals('.github/d1-migration-approvals.json'), []);
  assert.throws(() => loadApprovals('README.md'), GateError);
  assert.throws(() => loadApprovals('tsconfig.json'), GateError);
});

// Regression guard: every committed migration must stay additive, or carry an
// explicit content-matched approval. An accidental DELETE/DROP/UPDATE added to a
// migration file fails here before it can reach the gate.
for (const [directory, database] of [['migrations', 'DB'], ['migrations-analytics', 'ANALYTICS']]) {
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.sql')) continue;
    test(`committed migration ${directory}/${file} is additive or explicitly approved`, () => {
      const sql = readFileSync(`${directory}/${file}`, 'utf8');
      const classification = classifyMigration(sql);
      if (classification.verdict === 'additive-safe') return;
      const approvals = loadApprovals(APPROVALS);
      const approved = approvals.some(entry => entry.database === database && entry.file === file && entry.sha256 === sha256(sql));
      assert.ok(approved, `${directory}/${file} is ${classification.verdict} (${classification.reasons.join('; ')}) without a matching approval in ${APPROVALS}`);
    });
  }
}
