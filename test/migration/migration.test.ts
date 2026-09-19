import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  appInsertSql, assertGetOnly, buildImportPlan, collectComplete, cflabObjectKey, diffSnapshots,
  fileInsertSql, recordInsertSql, recordKey, redactUrl, rewriteLegacyFileUrls, sha256Hex, sqlValue,
  validateFile, validateRecord, verifyFileBytes,
  type ExistingState, type LegacyFile, type LegacyRecord, type Snapshot,
} from '../../scripts/migrate/lib.ts';

function record(overrides: Partial<LegacyRecord> = {}): LegacyRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', app_id: 'wildlife-field-recorder', resource: 'observations',
    data: { localId: 'a', latitude: 39.1, longitude: -86.2 }, created_at: '2026-05-16T19:39:00.421458+00:00',
    updated_at: '2026-05-16T19:39:00.421458+00:00', deleted_at: null, files: [],
    ...overrides,
  };
}
function file(overrides: Partial<LegacyFile> = {}): LegacyFile {
  return {
    id: '22222222-2222-4222-8222-222222222222', app_id: 'wildlife-field-recorder', resource: 'observations',
    record_id: '11111111-1111-4111-8111-111111111111', filename: 'photo.jpg', content_type: 'image/jpeg',
    size_bytes: 4, checksum: sha256Hex(new Uint8Array([1, 2, 3, 4])), created_at: '2026-05-16T19:39:01.000Z',
    url: 'https://lab.aismallbizguru.com/api/files/22222222-2222-4222-8222-222222222222', ...overrides,
  };
}
function snapshot(records: LegacyRecord[], files: LegacyFile[]): Snapshot {
  return {
    manifest: {
      snapshot_id: '20260918T000000Z', source: 'live LabBox read API', base_url: 'https://lab.aismallbizguru.com',
      started_at: '2026-09-18T00:00:00Z', completed_at: '2026-09-18T00:01:00Z',
      datasets: [{ app: 'wildlife-field-recorder', resource: 'observations', total: records.length, exported: records.length, complete: true }],
      files: { referenced: files.length, downloaded: files.length, bytes: files.reduce((total, item) => total + (item.size_bytes ?? 0), 0), missing: [], complete: true },
      rejected_records: 0,
      app_map: { 'wildlife-field-recorder': { name: 'Wildlife Field Recorder', origins: ['https://hmarquardt.github.io'] } },
    },
    records, files,
  };
}
function emptyState(): ExistingState {
  return { apps: new Map(), records: new Map(), files: new Map() };
}

test('rejects non-GET requests', () => {
  assert.doesNotThrow(() => assertGetOnly('GET'));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.throws(() => assertGetOnly(method), /non-GET/);
});
test('redacts credentials and query strings from logged URLs', () => {
  assert.equal(redactUrl('https://lab.example/api/records?token=secret#frag'), 'https://lab.example/api/records');
  assert.equal(redactUrl('/api/files/x?authorization=Bearer%20abc'), '/api/files/x');
  assert.ok(!redactUrl('https://lab.example/x?api_key=abc').includes('abc'));
});
test('collects a complete collection and rejects partial totals', async () => {
  const complete = await collectComplete('x', async () => ({ items: [1, 2, 3], total: 3 }));
  assert.deepEqual(complete.items, [1, 2, 3]);
  await assert.rejects(collectComplete('x', async () => ({ items: [1], total: 3 })), /incomplete collection/);
});
test('follows cursors, detects repeats, and stops on fetch failure', async () => {
  const pages: Record<string, { items: number[]; total?: number; next?: string | null }> = {
    start: { items: [1], total: 3, next: 'b' },
    b: { items: [2], total: 3, next: 'c' },
    c: { items: [3], total: 3, next: null },
  };
  assert.deepEqual((await collectComplete('x', async cursor => pages[cursor ?? 'start']!)).items, [1, 2, 3]);
  await assert.rejects(collectComplete('x', async () => ({ items: [], next: 'a' })), /repeated pagination cursor/);
  await assert.rejects(collectComplete('x', async () => { throw new Error('network down'); }), /network down/);
});
test('validates records and files without coercing malformed data', () => {
  assert.deepEqual(validateRecord(record()), []);
  assert.ok(validateRecord({ ...record(), data: [] }).includes('data is not an object'));
  assert.ok(validateRecord({ ...record(), id: '' }).includes('missing id'));
  assert.deepEqual(validateFile(file()), []);
  assert.ok(validateFile({ ...file(), size_bytes: -1 }).includes('invalid size_bytes'));
});
test('verifies downloaded bytes against size and checksum', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(verifyFileBytes(bytes, { size_bytes: 4, checksum: sha256Hex(bytes) }).ok, true);
  assert.equal(verifyFileBytes(bytes, { size_bytes: 5, checksum: sha256Hex(bytes) }).ok, false);
  assert.equal(verifyFileBytes(bytes, { size_bytes: 4, checksum: 'deadbeef' }).checksumOk, false);
  assert.equal(verifyFileBytes(bytes, { size_bytes: 4, checksum: null }).checksumOk, null);
});
test('rewrites only known legacy file URLs to CFLab routes', () => {
  const known = new Set([file().id]);
  const rewritten = rewriteLegacyFileUrls({ photo_url: file().url, image: 'https://elsewhere.example/x.jpg' }, 'wildlife-field-recorder', known);
  assert.equal(rewritten.data.photo_url, `/api/apps/wildlife-field-recorder/files/${file().id}/content`);
  assert.equal(rewritten.data.image, 'https://elsewhere.example/x.jpg');
  assert.deepEqual(rewritten.changed, ['photo_url']);
});
test('preserves stable IDs and builds deterministic insert SQL', () => {
  const plan = buildImportPlan(snapshot([record()], [file()]), emptyState());
  assert.equal(plan.records.insert[0]?.record.id, record().id);
  assert.equal(plan.files.insert[0]?.id, file().id);
  assert.equal(cflabObjectKey('wildlife-field-recorder', file().id), `apps/wildlife-field-recorder/files/${file().id}`);
  assert.match(recordInsertSql(record(), '{}'), /INSERT INTO records/);
  assert.match(fileInsertSql(file()), /INSERT INTO files/);
  assert.match(appInsertSql('demo', "O'Brien", ['https://x.example'])[0]!, /O''Brien/);
  assert.equal(sqlValue("a'b"), "'a''b'");
});
test('dry-run planning performs no mutation and reports intended work', () => {
  const before = JSON.stringify(snapshot([record()], [file()]));
  const plan = buildImportPlan(snapshot([record()], [file()]), emptyState());
  assert.equal(plan.records.insert.length, 1);
  assert.equal(plan.files.insert.length, 1);
  assert.equal(plan.bytesToCopy, 4);
  assert.equal(JSON.stringify(snapshot([record()], [file()])), before);
});
test('import is idempotent for identical rows and reports conflicts for differences', () => {
  const source = snapshot([record()], [file()]);
  const state = emptyState();
  state.apps.set('wildlife-field-recorder', { name: 'Wildlife Field Recorder', active: true, origins: new Set(['https://hmarquardt.github.io']) });
  state.records.set(recordKey(record()), { data_json: JSON.stringify(record().data), created_at: record().created_at, updated_at: record().updated_at });
  state.files.set(file().id, { size_bytes: file().size_bytes!, checksum: file().checksum! });
  const first = buildImportPlan(source, state);
  assert.equal(first.records.insert.length, 0);
  assert.equal(first.records.present.length, 1);
  assert.equal(first.files.present.length, 1);
  assert.equal(first.appsToCreate.length, 0);
  const changed = emptyState();
  changed.records.set(recordKey(record()), { data_json: JSON.stringify({ localId: 'different' }), created_at: record().created_at, updated_at: record().updated_at });
  const second = buildImportPlan(source, changed);
  assert.equal(second.records.conflicts.length, 1);
  assert.equal(buildImportPlan(source, changed, true).records.insert.length, 1);
});
test('detects orphaned file relationships', () => {
  const orphan = file({ record_id: '33333333-3333-4333-8333-333333333333' });
  const plan = buildImportPlan(snapshot([record()], [orphan]), emptyState());
  assert.deepEqual(plan.files.orphans, [orphan.id]);
});
test('diffs snapshots for delta reconciliation', () => {
  const changedRecord = record({ updated_at: '2026-09-18T00:00:00Z', data: { localId: 'changed' } });
  const newRecord = record({ id: '44444444-4444-4444-8444-444444444444' });
  const removedRecord = record({ id: '55555555-5555-4555-8555-555555555555' });
  const delta = diffSnapshots(snapshot([record(), removedRecord], [file()]), snapshot([changedRecord, newRecord], [file()]));
  assert.deepEqual(delta.records, { added: 1, changed: 1, disappeared: 1, unchanged: 0 });
  assert.deepEqual(delta.files, { added: 0, changed: 0, disappeared: 0, unchanged: 1 });
});

test('public Safari client contains no embedded credential and targets CFLab public routes', () => {
  const candidates = [process.env.SAFARI_CLIENT_PATH, new URL('../../../junkdrawer/hank_heather_wilderness_safari.html', import.meta.url).pathname];
  const path = candidates.find(candidate => candidate && existsSync(candidate));
  if (!path) return;
  const html = readFileSync(path, 'utf8');
  assert.doesNotMatch(html, /READONLY_TOKEN|Authorization|Bearer /);
  assert.doesNotMatch(html, /(?:^|[^a-z])lab\.aismallbizguru\.com\/api\/(?!analytics)/m);
  assert.doesNotMatch(html, /['"][A-Za-z0-9_-]{32,}['"]/);
  assert.match(html, /cflab\.aismallbizguru\.com\/api\/public\/wildlife-safari/);
});

test('Pattern Lab client uses CFLab human sessions with no legacy token handling', () => {
  const candidates = [process.env.PATTERN_LAB_CLIENT_PATH, new URL('../../../junkdrawer/wildlife-pattern-lab.html', import.meta.url).pathname];
  const path = candidates.find(candidate => candidate && existsSync(candidate));
  if (!path) return;
  const html = readFileSync(path, 'utf8');
  assert.match(html, /cflab\.aismallbizguru\.com/);
  assert.doesNotMatch(html, /(?:^|[^a-z])lab\.aismallbizguru\.com\/api\/(?!analytics)/m);
  assert.doesNotMatch(html, /READONLY_TOKEN|authHeaders|saveSettings|loadSettingsForm|settings\.token|save-settings/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /api\/auth\/login/);
  assert.match(html, /api\/auth\/me/);
  assert.match(html, /next_cursor/);
  assert.match(html, /Malformed pagination cursor/);
  assert.match(html, /Repeated pagination cursor/);
  assert.match(html, /existing cache kept/);
});
