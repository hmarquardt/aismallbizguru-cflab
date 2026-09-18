import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import production from '../src/index';
import local from '../src/local';
import type { Bindings } from '../src/types';
import { SCOPES } from '../src/auth/tokens';
import { publicAddress } from '../src/proxy/dns';
import { safeUrl } from '../src/proxy/policy';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn(async () => ['104.21.1.1']), resolve6: vi.fn(async () => []) }));
import { resolve4 } from 'node:dns/promises';

const adminSecret = 'local-test-only-secret-with-32-characters';
const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const testEnv = { ...bindings, DEV_ADMIN_TOKEN: adminSecret, PROXY_SECRETS: '{"WEATHER_KEY":"server-only-secret"}' };
const root = '/api/apps/demo';
const records = `${root}/resources/notes/records`;
let token: string;

async function call(path: string, method = 'GET', body?: unknown, bearer: string | null = token, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);
}
const admin = (path: string, method = 'GET', body?: unknown) => call(`/api/admin${path}`, method, body, adminSecret);
async function makeToken(app = 'demo', permissions: string[] = SCOPES) {
  const response = await admin(`/apps/${app}/tokens`, 'POST', { name: 'test', scopes: permissions });
  expect(response.status).toBe(201);
  return await response.json<{ id: string; token: string }>();
}
async function source(config: Record<string, unknown> = {}) {
  const response = await admin('/apps/demo/proxy-sources/weather', 'PUT', { config: {
    base_url: 'https://api.open-meteo.com/v1/forecast', query_params: ['latitude'], ...config,
  } });
  expect(response.status).toBe(200);
}
beforeAll(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.DB.batch([bindings.DB.prepare('DELETE FROM files'), bindings.DB.prepare('DELETE FROM apps')]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map(o => o.key));
  for (const app of ['demo', 'other']) {
    const response = await admin('/apps', 'POST', { id: app, name: app, origins: ['https://client.example'] });
    expect(response.status).toBe(201);
  }
  token = (await makeToken()).token;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('health and administration', () => {
  it('serves health through the actual Worker entrypoint', async () => {
    const response = await exports.default.fetch('https://example.com/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'cflab' });
  });
  it.each(['https://cflab.aismallbizguru.com', 'https://future-api.example'])('health is hostname-independent and dependency-free at %s', async origin => {
    const response = await production.fetch(new Request(`${origin}/api/health`), {} as Bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'cflab' });
  });
  it('production rejects even valid local admin credentials', async () => {
    const response = await production.fetch(new Request('http://localhost/api/admin/apps', { headers: { Authorization: `Bearer ${adminSecret}` } }), testEnv);
    expect(response.status).toBe(403);
  });
  it('rejects browser-origin and non-loopback local admin requests', async () => {
    expect((await call('/api/admin/apps', 'GET', undefined, adminSecret, { Origin: 'https://client.example' })).status).toBe(403);
    expect((await local.fetch(new Request('https://evil.example/api/admin/apps', { headers: { Authorization: `Bearer ${adminSecret}` } }), testEnv)).status).toBe(403);
    expect((await call('/api/admin/apps', 'GET', undefined, null)).status).toBe(403);
  });
  it('reads and updates apps including origins and inactivity', async () => {
    expect((await admin('/apps/demo')).status).toBe(200);
    expect(await (await call(root)).json()).toMatchObject({ id: 'demo', name: 'demo', config: {} });
    expect((await admin('/apps/demo', 'PATCH', { name: 'New', origins: [], active: false })).status).toBe(200);
    expect((await call(records)).status).toBe(404);
    expect((await admin('/apps/demo')).status).toBe(200);
  });
  it('rejects duplicate apps and invalid origins', async () => {
    expect((await admin('/apps', 'POST', { id: 'demo', name: 'duplicate' })).status).toBe(409);
    expect((await admin('/apps/demo', 'PATCH', { origins: ['*'] })).status).toBe(400);
    expect((await admin('/apps/demo', 'PATCH', { origins: ['https://client.example/path'] })).status).toBe(400);
  });
  it('creates app and origins atomically', async () => {
    await bindings.DB.prepare("CREATE TRIGGER fail_origin_insert BEFORE INSERT ON app_origins BEGIN SELECT RAISE(ABORT, 'failure'); END").run();
    try {
      expect((await admin('/apps', 'POST', { id: 'atomic', name: 'Atomic', origins: ['https://client.example'] })).status).toBe(500);
      expect(await bindings.DB.prepare('SELECT id FROM apps WHERE id = ?').bind('atomic').first()).toBeNull();
    } finally { await bindings.DB.prepare('DROP TRIGGER fail_origin_insert').run(); }
  });
});

describe('records, isolation, and tokens', () => {
  it('creates, reads, replaces data, clears status, and deletes', async () => {
    const create = await call(records, 'POST', { data: { title: 'Hello', old: true }, status: 'draft' });
    expect(create.status).toBe(201);
    const record = await create.json<{ id: string; data: unknown }>();
    const path = `${records}/${record.id}`;
    expect((await call(path)).status).toBe(200);
    const patch = await call(path, 'PATCH', { data: { title: 'Updated' }, status: null });
    expect(await patch.json()).toMatchObject({ data: { title: 'Updated' }, status: null });
    const list = await (await call(records)).json<{ records: { data: unknown }[] }>();
    expect(list.records).toHaveLength(1);
    expect(list.records[0]?.data).toEqual({ title: 'Updated' });
    expect((await call(path, 'DELETE')).status).toBe(204);
    expect((await call(path)).status).toBe(404);
    expect((await call(path, 'PATCH', { data: {} })).status).toBe(404);
    expect((await call(path, 'DELETE')).status).toBe(404);
  });
  it('paginates without overlap and filters status', async () => {
    for (let i = 0; i < 3; i++) await call(records, 'POST', { data: { i }, status: i === 2 ? 'done' : 'draft' });
    const first = await (await call(`${records}?limit=2`)).json<{ records: { id: string }[]; next_cursor: string }>();
    expect(first.records).toHaveLength(2);
    const second = await (await call(`${records}?limit=2&after=${first.next_cursor}`)).json<{ records: { id: string }[]; next_cursor: null }>();
    expect(second.records).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.records, ...second.records].map(r => r.id)).size).toBe(3);
    expect(await (await call(`${records}?status=done`)).json()).toMatchObject({ records: [{ status: 'done' }] });
  });
  it('isolates apps and resources for reads, writes, and deletes', async () => {
    const { id } = await (await call(records, 'POST', { data: {} })).json<{ id: string }>();
    const other = (await makeToken('other')).token;
    expect((await call(`/api/apps/other/resources/notes/records/${id}`)).status).toBe(401);
    for (const [method, body] of [['GET', undefined], ['PATCH', { data: {} }], ['DELETE', undefined]] as const) {
      expect((await call(`/api/apps/other/resources/notes/records/${id}`, method, body, other)).status).toBe(404);
      expect((await call(`${root}/resources/another/records/${id}`, method, body)).status).toBe(404);
    }
    expect((await call(`${records}/${id}`)).status).toBe(200);
  });
  it('requires authentication and exact scopes', async () => {
    expect((await call(records, 'GET', undefined, null)).status).toBe(401);
    expect((await call(records, 'GET', undefined, 'bogus')).status).toBe(401);
    const readOnly = (await makeToken('demo', ['records:read'])).token;
    expect((await call(records, 'GET', undefined, readOnly)).status).toBe(200);
    expect((await call(records, 'POST', { data: {} }, readOnly)).status).toBe(403);
    expect((await call(`${root}/files`, 'GET', undefined, readOnly)).status).toBe(403);
    expect((await call(`${root}/proxy/weather`, 'GET', undefined, readOnly)).status).toBe(403);
    expect((await admin('/apps/demo/tokens', 'POST', { name: 'bad', scopes: ['*'] })).status).toBe(400);
  });
  it('stores only hashes, never lists secrets, and revokes tokens', async () => {
    const created = await makeToken();
    const row = await bindings.DB.prepare('SELECT token_hash FROM api_tokens WHERE id = ?').bind(created.id).first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toBe(created.token);
    const list = await (await admin('/apps/demo/tokens')).text();
    expect(list).not.toContain(created.token);
    expect(list).not.toContain('token_hash');
    expect((await admin(`/apps/demo/tokens/${created.id}`, 'DELETE')).status).toBe(204);
    expect((await call(records, 'GET', undefined, created.token)).status).toBe(401);
  });
  it('treats SQL syntax inside data and filters as literal values', async () => {
    const injection = "'; DROP TABLE apps; --";
    const created = await call(records, 'POST', { data: { title: injection }, status: injection });
    expect(created.status).toBe(201);
    const result = await (await call(`${records}?status=${encodeURIComponent(injection)}`)).json<{ records: { data: { title: string } }[] }>();
    expect(result.records[0]?.data.title).toBe(injection);
    expect((await call(root)).status).toBe(200);
  });
  it.each(['?limit=0', '?limit=101', '?limit=no', '?after=bad', '?order=title', '?limit=1&limit=2'])( 'rejects malformed pagination %s', async query => {
    expect((await call(records + query)).status).toBe(400);
  });
  it.each([null, [], { data: [] }, { data: {}, extra: true }, { data: {}, status: 10 }])('rejects malformed record input %j', async body => {
    expect((await call(records, 'POST', body)).status).toBe(400);
  });
  it('handles malformed JSON, wrong media types, and oversized JSON', async () => {
    for (const [body, type, status] of [['{', 'application/json', 400], ['{}', 'text/plain', 415], [JSON.stringify({ data: { text: 'x'.repeat(65536) } }), 'application/json', 413]] as const) {
      const response = await local.fetch(new Request(`http://localhost${records}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body }), testEnv);
      expect(response.status).toBe(status);
      expect(await response.json()).toHaveProperty('error.code');
    }
  });
});

describe('CORS', () => {
  it('allows configured origins including on authentication errors', async () => {
    const response = await call(records, 'GET', undefined, null, { Origin: 'https://client.example' });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
    expect(response.headers.get('Vary')).toContain('Origin');
  });
  it('denies unknown and null origins and emits no wildcard', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const response = await call(records, 'GET', undefined, token, { Origin: origin });
      expect(response.status).toBe(403);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    expect((await call(records)).headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('handles unauthenticated preflight and denies unsafe headers/methods', async () => {
    const headers = { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' };
    expect((await call(records, 'OPTIONS', undefined, null, headers)).status).toBe(204);
    expect((await call(records, 'OPTIONS', undefined, null, { ...headers, 'Access-Control-Request-Headers': 'x-admin' })).status).toBe(403);
    expect((await call(records, 'OPTIONS', undefined, null, { ...headers, 'Access-Control-Request-Method': 'TRACE' })).status).toBe(403);
  });
});

describe('files', () => {
  it('stores bytes in R2, metadata in D1, streams downloads, and deletes both', async () => {
    const response = await local.fetch(new Request(`http://localhost${root}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'X-Filename': 'hello.txt' }, body: 'hello' }), testEnv);
    expect(response.status).toBe(201);
    const file = await response.json<{ id: string; checksum: string; download_url: string; object_key?: string }>();
    expect(file.object_key).toBeUndefined();
    expect(file.checksum).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    const row = await bindings.DB.prepare('SELECT object_key, size_bytes FROM files WHERE app_id = ? AND id = ?').bind('demo', file.id).first<{ object_key: string; size_bytes: number }>();
    expect(row?.size_bytes).toBe(5);
    expect(await (await bindings.FILES.get(row!.object_key))?.text()).toBe('hello');
    const download = await call(file.download_url, 'GET', undefined, token, { Origin: 'https://client.example' });
    expect(await download.text()).toBe('hello');
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(download.headers.get('Cache-Control')).toBe('no-store');
    expect(download.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
    expect((await call(`${root}/files/${file.id}`)).status).toBe(200);
    expect(await (await call(`${root}/files`)).json()).toMatchObject({ files: [{ id: file.id }] });
    const other = (await makeToken('other')).token;
    for (const suffix of ['', '/content']) expect((await call(`/api/apps/other/files/${file.id}${suffix}`, 'GET', undefined, other)).status).toBe(404);
    expect((await call(`/api/apps/other/files/${file.id}`, 'DELETE', undefined, other)).status).toBe(404);
    expect((await call(`${root}/files/${file.id}`, 'DELETE')).status).toBe(204);
    expect(await bindings.FILES.get(row!.object_key)).toBeNull();
    expect((await call(file.download_url)).status).toBe(404);
  });
  it('rejects uploads over the cap without objects or metadata', async () => {
    const response = await local.fetch(new Request(`http://localhost${root}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(8 * 1024 * 1024 + 1) }), testEnv);
    expect(response.status).toBe(413);
    expect((await bindings.FILES.list()).objects).toHaveLength(0);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM files').first('n')).toBe(0);
  });
  it('removes R2 bytes if metadata insertion fails and returns a sanitized error', async () => {
    await bindings.DB.prepare("CREATE TRIGGER fail_file_insert BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'sensitive database details'); END").run();
    try {
      const response = await local.fetch(new Request(`http://localhost${root}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'hello' }), testEnv);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      expect((await bindings.FILES.list()).objects).toHaveLength(0);
      expect(await bindings.DB.prepare('SELECT count(*) AS n FROM files').first('n')).toBe(0);
    } finally { await bindings.DB.prepare('DROP TRIGGER fail_file_insert').run(); }
  });
  it('allows deletion to be retried after a D1 failure following R2 deletion', async () => {
    const created = await local.fetch(new Request(`http://localhost${root}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'hello' }), testEnv);
    expect(created.status).toBe(201);
    const file = await created.json<{ id: string; download_url: string }>();
    await bindings.DB.prepare("CREATE TRIGGER fail_file_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'failure'); END").run();
    try {
      expect((await call(`${root}/files/${file.id}`, 'DELETE')).status).toBe(500);
      expect((await call(file.download_url)).status).toBe(503);
    } finally { await bindings.DB.prepare('DROP TRIGGER fail_file_delete').run(); }
    expect((await call(`${root}/files/${file.id}`, 'DELETE')).status).toBe(204);
  });
});

describe('configured proxy', () => {
  it.each(['http://api.open-meteo.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/', 'https://10.0.0.1/', 'https://localhost/', 'https://metadata.google.internal/', 'file:///etc/passwd', 'https://api.open-meteo.com.evil.example/', 'https://user:pass@api.open-meteo.com/', 'https://api.open-meteo.com:8443/', 'https://api.open-meteo.com/?url=x', 'https://api.open-meteo.com/#x'])('rejects unsafe source %s', async url => {
    const result = await admin('/apps/demo/proxy-sources/weather', 'PUT', { config: { base_url: url } });
    expect(result.status).toBe(400);
  });
  it('rejects private literals even if explicitly allowlisted', () => {
    expect(() => safeUrl('https://127.0.0.1/', '127.0.0.1')).toThrow();
    expect(() => safeUrl('https://metadata.google.internal/', 'metadata.google.internal')).toThrow();
  });
  it.each(['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1'])('rejects nonpublic DNS answer %s', address => {
    expect(publicAddress(address)).toBe(false);
  });
  it('forwards only approved query/secret headers, strips upstream headers', async () => {
    await source({ secret_headers: { Authorization: 'WEATHER_KEY' } });
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.href).toBe('https://api.open-meteo.com/v1/forecast?latitude=42');
      expect(new Headers(init?.headers).get('Authorization')).toBe('server-only-secret');
      expect(init?.redirect).toBe('manual');
      return new Response('{"weather":"sun"}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'secret=1', Location: 'https://evil.example', 'Access-Control-Allow-Origin': '*' } });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await call(`${root}/proxy/weather?latitude=42`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ weather: 'sun' });
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(response.headers.has('Location')).toBe(false);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('blocks private DNS answers before fetch', async () => {
    await source();
    vi.mocked(resolve4).mockResolvedValueOnce(['127.0.0.1'] as never);
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await call(`${root}/proxy/weather`)).status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('enforces app ownership and current operator host policy', async () => {
    await source(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const other = (await makeToken('other')).token;
    expect((await call('/api/apps/other/proxy/weather', 'GET', undefined, other)).status).toBe(404);
    const response = await local.fetch(new Request(`http://localhost${root}/proxy/weather`, { headers: { Authorization: `Bearer ${token}` } }), { ...testEnv, PROXY_ALLOWED_HOSTS: '' });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('fails closed when DNS errors or mixes private and public addresses', async () => {
    await source(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    vi.mocked(resolve4).mockRejectedValueOnce(new Error('DNS unavailable'));
    expect((await call(`${root}/proxy/weather`)).status).toBe(502);
    vi.mocked(resolve4).mockResolvedValueOnce(['104.21.1.1', '169.254.169.254'] as never);
    expect((await call(`${root}/proxy/weather`)).status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects arbitrary destination, duplicate query, inactive source and wrong method', async () => {
    await source(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await call(`${root}/proxy/weather?url=https://localhost`)).status).toBe(400);
    expect((await call(`${root}/proxy/weather?latitude=1&latitude=2`)).status).toBe(400);
    expect((await call(`${root}/proxy/weather`, 'POST')).status).toBe(405);
    await admin('/apps/demo/proxy-sources/weather', 'PUT', { active: false, config: { base_url: 'https://api.open-meteo.com/v1/forecast' } });
    expect((await call(`${root}/proxy/weather`)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([302, 307, 500])('rejects upstream status %s without following redirects', async status => {
    await source(); const upstream = vi.fn(async () => new Response('secret', { status, headers: { Location: 'http://169.254.169.254/', 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const response = await call(`${root}/proxy/weather`);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('rejects disallowed content types and oversized bodies without content-length', async () => {
    await source({ max_response_bytes: 10 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } })));
    expect((await call(`${root}/proxy/weather`)).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(11), { headers: { 'Content-Type': 'application/json' } })));
    expect((await call(`${root}/proxy/weather`)).status).toBe(502);
  });
  it('times out during response body reading', async () => {
    await source({ timeout_ms: 100 });
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    } }), { headers: { 'Content-Type': 'application/json' } })));
    expect((await call(`${root}/proxy/weather`)).status).toBe(504);
  });
  it.each([{ methods: ['POST'] }, { query_params: ['url'] }, { timeout_ms: 0 }, { max_response_bytes: 99999999 }, { cache_ttl: 30 }, { headers: { Host: 'localhost' } }, { headers: { Authorization: 'secret' } }])('validates source policy %j', async config => {
    expect((await admin('/apps/demo/proxy-sources/weather', 'PUT', { config: { base_url: 'https://api.open-meteo.com/', ...config } })).status).toBe(400);
  });
});
