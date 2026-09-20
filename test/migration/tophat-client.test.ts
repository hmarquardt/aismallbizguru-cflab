import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function clientPath(): string | null {
  const candidates = [
    process.env.TOPHAT_CLIENT_PATH,
    new URL('../../../tophatferals/index.html', import.meta.url).pathname,
  ];
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? null;
}
const path = clientPath();
const html = path ? readFileSync(path, 'utf8') : '';

function extract(name: string): string {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return match[0];
}
function extractClass(name: string): string {
  const match = new RegExp(`class ${name} extends Error \\{[\\s\\S]*?\\n      \\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return match[0];
}
const DIAG_KEY_LINE = /const DIAG_KEY = [^\n]+/.exec(html)?.[0] ?? '';
const DIAG_CAP_LINE = /const DIAG_CAP = [^\n]+/.exec(html)?.[0] ?? '';
const normalizeSighting = path
  ? new Function(`${extract('unwrapLabBoxRecord')}\n${extract('normalizeDate')}\n${extract('normalizeSighting')}; return normalizeSighting;`)() as (record: unknown) => Record<string, unknown> | null
  : null;

test('linked public projection image wins over a stale payload photo_url', { skip: !path }, () => {
  const record = normalizeSighting!({
    id: 'r1',
    data: { cat_name: 'Test', photo_url: '/api/apps/top-hat-ferals/files/stale/content' },
    photos: [{ id: 'f1', url: 'https://cflab.aismallbizguru.com/api/public/top-hat-ferals/files/f1', content_type: 'image/jpeg' }],
  });
  assert.equal(record?.photo_url, 'https://cflab.aismallbizguru.com/api/public/top-hat-ferals/files/f1');
});

test('manual photo_url remains usable when no linked file exists', { skip: !path }, () => {
  const record = normalizeSighting!({ id: 'r2', data: { photo_url: 'https://example.com/manual.jpg' }, photos: [] });
  assert.equal(record?.photo_url, 'https://example.com/manual.jpg');
  const empty = normalizeSighting!({ id: 'r3', data: {} });
  assert.equal(empty?.photo_url, null);
});

test('the origin migration seeds both Top Hat production origins', () => {
  const migration = readFileSync(new URL('../../migrations/0006_top_hat_origins.sql', import.meta.url), 'utf8');
  assert.match(migration, /INSERT OR IGNORE INTO app_origins/);
  assert.ok(migration.includes("'https://tophatferals.com'"));
  assert.ok(migration.includes("'https://www.tophatferals.com'"));
});

test('upload flow no longer patches authenticated download URLs into records', { skip: !path }, () => {
  assert.doesNotMatch(html, /updateRecordPhotoUrl|extractFileUrl/);
  assert.doesNotMatch(html, /photo_url PATCH/);
  assert.equal((html.match(/photos\[0\]\.url/g) ?? []).length, 3);
  assert.match(html, /X-Record-Id/);
  assert.match(html, /X-Resource/);
});


function diagnosticsHarness() {
  const storage = new Map<string, string>();
  const sessionStorageStub = {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const source = [
    DIAG_KEY_LINE, DIAG_CAP_LINE, extractClass('ApiClientError'),
    extract('readDiagnostics'), extract('writeDiagnostics'), extract('logDiagnostic'),
    extract('recentErrorCount'), extract('updateDiagnosticBadge'),
  ].join('\n');
  return new Function('sessionStorage', 'document', 'adminSection', `${source}; return { logDiagnostic, readDiagnostics, writeDiagnostics, recentErrorCount };`)(
    sessionStorageStub, { getElementById: () => null }, undefined,
  ) as { logDiagnostic: (event: Record<string, unknown>) => Record<string, unknown>; readDiagnostics: () => Array<Record<string, unknown>>; writeDiagnostics: (list: unknown[]) => void; recentErrorCount: () => number };
}

test('diagnostics ring buffer is bounded, newest first, and clearable', { skip: !path }, () => {
  const diag = diagnosticsHarness();
  for (let i = 0; i < 200; i++) diag.logDiagnostic({ level: 'info', operation: 'upload_file', message: 'event ' + i });
  const list = diag.readDiagnostics();
  assert.equal(list.length, 150);
  assert.equal(list[0]!.message, 'event 199');
  assert.equal(list[149]!.message, 'event 50');
  diag.writeDiagnostics([]);
  assert.equal(diag.readDiagnostics().length, 0);
});

test('diagnostics keep safe operational metadata and drop sensitive extras', { skip: !path }, () => {
  const diag = diagnosticsHarness();
  const entry = diag.logDiagnostic({
    level: 'error', operation: 'upload_file', stage: 'response', method: 'POST',
    path: '/api/apps/top-hat-ferals/files?token=secret', status: 400, error_code: 'invalid_input',
    message: 'Expected a MIME type without parameters',
    record_id: '11111111-1111-4111-8111-111111111111',
    file: { name: 'Screenshot 2026-09-20 at 10.00.00 AM.png', type: 'image/png', size: 482193 },
    token: 'cflu_secret', authorization: 'Bearer cflu_secret', password: 'hunter2', body: '{"note":"private location"}',
  });
  assert.deepEqual(Object.keys(entry).sort(), ['duration_ms', 'error_code', 'file', 'level', 'message', 'method', 'operation', 'path', 'record_id', 'stage', 'status', 'time'].sort());
  assert.equal(entry.path, '/api/apps/top-hat-ferals/files');
  const serialized = JSON.stringify(entry);
  for (const forbidden of ['cflu_', 'Bearer', 'hunter2', 'private location']) assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
  assert.deepEqual(entry.file, { name: 'Screenshot 2026-09-20 at 10.00.00 AM.png', type: 'image/png', size: 482193 });
});

test('diagnostics copy output is sanitized and never references credentials', { skip: !path }, () => {
  const copyLine = /const text = entries\.map\(e => `[\s\S]*?\)\.join\("\\n"\);/.exec(html)?.[0] ?? '';
  assert.ok(copyLine.length > 0);
  assert.doesNotMatch(copyLine, /authorization|sessionToken|password|token/i);
  assert.match(html, /No tokens, passwords, request bodies, or file bytes are recorded\./);
});

function uploadHarness() {
  const sessionCalls: string[] = [];
  const statusCalls: string[] = [];
  const source = `${extractClass('ApiClientError')}\n${extract('apiFetchJson')}; return apiFetchJson;`;
  const apiFetchJson = new Function('CONFIG', 'withAuth', 'logDiagnostic', 'setSessionToken', 'setStatus',
    source)({ apiBase: 'https://cflab.example' }, () => ({ Authorization: 'Bearer cflu_test' }), () => {}, (token: string) => { sessionCalls.push(token); }, (message: string) => { statusCalls.push(message); });
  return { apiFetchJson: apiFetchJson as (options: Record<string, unknown>) => Promise<unknown>, sessionCalls, statusCalls };
}

test('upload errors surface status, backend code, and message distinctly', { skip: !path }, async () => {
  const { apiFetchJson, sessionCalls } = uploadHarness();
  const originalFetch = globalThis.fetch;
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  };
  try {
    respond(400, { error: { code: 'invalid_input', message: 'Expected a MIME type without parameters' } });
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x', body: 'b' }), (error: unknown) => (error as { status: number }).status === 400 && (error as { code: string }).code === 'invalid_input' && /MIME type/.test((error as Error).message));
    respond(409, { error: { code: 'file_exists', message: 'File id already exists with different content' } });
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x' }), (error: unknown) => (error as { status: number }).status === 409 && (error as { code: string }).code === 'file_exists');
    respond(413, { error: { code: 'body_too_large', message: 'Body exceeds size limit' } });
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x' }), (error: unknown) => (error as { status: number }).status === 413);
    respond(403, { error: { code: 'origin_not_allowed', message: 'Origin not allowed' } });
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x' }), (error: unknown) => (error as { status: number }).status === 403);
    respond(401, { error: { code: 'unauthorized', message: 'Invalid or expired session' } });
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x' }), (error: unknown) => (error as { status: number }).status === 401);
    assert.equal(sessionCalls.length, 1);
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await assert.rejects(apiFetchJson({ operation: 'upload_file', method: 'POST', path: '/x' }), (error: unknown) => (error as { code: string }).code === 'network_error' && /Network error/.test((error as Error).message));
  } finally { globalThis.fetch = originalFetch; }
});

test('file create ids are stable per file, unique across files, and UUID-shaped', { skip: !path }, async () => {
  const fileCreateId = new Function(`${extract('fileCreateId')}; return fileCreateId;`)() as (resource: string, recordId: string, file: { name: string; size: number; lastModified: number; type: string }) => Promise<string>;
  const file = { name: 'Screenshot.png', size: 482193, lastModified: 1789912345678, type: 'image/png' };
  const first = await fileCreateId('sightings', 'record-1', file);
  const retry = await fileCreateId('sightings', 'record-1', file);
  const other = await fileCreateId('sightings', 'record-1', { ...file, size: file.size + 1 });
  assert.equal(first, retry);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('manage edit preserves unknown fields and uploads stay linked', { skip: !path }, () => {
  assert.match(html, /const merged = \{ \.\.\.d \};/);
  assert.match(html, /const setOrDelete =/);
  assert.match(html, /X-Record-Id/);
  assert.match(html, /X-Resource/);
  assert.doesNotMatch(html, /updateRecordPhotoUrl/);
  assert.match(html, /Archive this sighting\? It will disappear from the public site\. Linked files are kept\./);
});
