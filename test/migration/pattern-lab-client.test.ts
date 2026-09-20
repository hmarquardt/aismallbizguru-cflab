import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function clientPath(): string | null {
  const candidates = [
    process.env.PATTERN_LAB_CLIENT_PATH,
    new URL('../../../junkdrawer/wildlife-pattern-lab.html', import.meta.url).pathname,
  ];
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? null;
}
const path = clientPath();
const html = path ? readFileSync(path, 'utf8') : '';

let uuidCounter = 0;
const cryptoStub = { randomUUID: () => `uuid-${++uuidCounter}` };
function toMillis(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
function extractFunction(name: string): (row: unknown) => Record<string, unknown> | null {
  const match = new RegExp(`function ${name}\\(row\\) \\{[\\s\\S]*?\\n\\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return new Function('toMillis', 'crypto', `${match[0]}; return ${name};`)(toMillis, cryptoStub) as (row: unknown) => Record<string, unknown> | null;
}

test('duplicate localId with distinct backend ids yields distinct cache keys and both are retained', { skip: !path }, () => {
  const normalizeRecord = extractFunction('normalizeRecord');
  const first = normalizeRecord({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', data: { localId: 'shared-local', createdAt: 1000 } });
  const second = normalizeRecord({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', data: { localId: 'shared-local', createdAt: 1000 } });
  assert.ok(first && second);
  assert.equal(first.localId, 'shared-local');
  assert.equal(second.localId, 'shared-local');
  assert.notEqual(first.id, second.id);
  const cache = new Map<string, unknown>();
  cache.set(String(first.id), first);
  cache.set(String(second.id), second);
  assert.equal(cache.size, 2);
});

test('multiple collisions across several localIds all survive', { skip: !path }, () => {
  const normalizeRecord = extractFunction('normalizeRecord');
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', data: { localId: 'dup-a' } },
    { id: '22222222-2222-4222-8222-222222222222', data: { localId: 'dup-a' } },
    { id: '33333333-3333-4333-8333-333333333333', data: { localId: 'dup-b' } },
    { id: '44444444-4444-4444-8444-444444444444', data: { localId: 'dup-b' } },
    { id: '55555555-5555-4555-8555-555555555555', data: { localId: 'unique' } },
  ];
  const cache = new Map<string, unknown>();
  for (const row of rows) {
    const normalized = normalizeRecord(row);
    assert.ok(normalized);
    cache.set(String(normalized.id), normalized);
  }
  assert.equal(cache.size, 5);
});

test('unique backend ids remain unique and localId is metadata only', { skip: !path }, () => {
  const normalizeRecord = extractFunction('normalizeRecord');
  const row = { id: '99999999-9999-4999-8999-999999999999', data: { localId: 'meta-only' } };
  const once = normalizeRecord(row);
  const twice = normalizeRecord(row);
  assert.ok(once && twice);
  assert.equal(once.id, row.id);
  assert.equal(twice.id, row.id);
  assert.equal(once.localId, 'meta-only');
  const other = normalizeRecord({ id: '88888888-8888-4888-8888-888888888888', data: { localId: 'meta-only' } });
  assert.ok(other);
  assert.notEqual(other.id, once.id);
});

test('malformed and import rows are handled safely', { skip: !path }, () => {
  const normalizeRecord = extractFunction('normalizeRecord');
  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ id: 'x', data: 'not-an-object' }), null);
  assert.equal(normalizeRecord({ id: 'x', data: 42 }), null);
  const imported = normalizeRecord({ data: { localId: 'phone-export-1', createdAt: 1000 } });
  assert.ok(imported);
  assert.equal(imported.id, 'phone-export-1');
  assert.equal(imported.localId, 'phone-export-1');
  const anonymous = normalizeRecord({ data: { createdAt: 1000 } });
  assert.ok(anonymous);
  assert.equal(anonymous.id, 'uuid-1');
  assert.equal(anonymous.localId, 'uuid-1');
});

test('client schema keys observations by backend id and drops the legacy store', { skip: !path }, () => {
  assert.match(html, /observations_v2: 'id, localId, backendId, createdAt, category, subjectCommonName'/);
  assert.match(html, /db\.version\(4\)\.stores\(\{\s*observations: null,/);
  assert.match(html, /tx\.table\('observations'\)\.toArray\(\)/);
  assert.match(html, /tx\.table\('observations_v2'\)\.bulkPut/);
  assert.doesNotMatch(html, /db\.observations(?!_v2)/);
  assert.match(html, /const stored = await db\.observations_v2\.count\(\);/);
  assert.match(html, /Stored observation count differs from fetched count/);
});
