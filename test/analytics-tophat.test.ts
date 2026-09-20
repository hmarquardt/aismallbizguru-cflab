import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../src/local';
import type { Bindings } from '../src/types';
import { hashPassword } from '../src/auth/passwords';

const adminSecret = 'local-test-only-secret-with-32-characters';
const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_ANALYTICS_MIGRATIONS: { name: string; queries: string[] }[];
};
const testEnv = {
  ...bindings,
  DEV_ADMIN_TOKEN: adminSecret,
  RL_ANALYTICS: { limit: async () => ({ success: true }) },
} as unknown as Bindings & { DEV_ADMIN_TOKEN: string };
const password = 'correct horse battery staple';
const tophatOrigin = 'https://hmarquardt.github.io';
const topHatSightingId = '11111111-1111-4111-8111-111111111111';
const topHatImageId = '22222222-2222-4222-8222-222222222222';
const wildlifeImageId = '33333333-3333-4333-8333-333333333333';

async function call(path: string, method = 'GET', body?: unknown, bearer?: string | null, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);
}
function collectPayload(overrides: Record<string, unknown> = {}) {
  return {
    site_id: 'junkdrawer', event_type: 'pageview', visitor_id: 'v_test_1', session_id: 's_test_1',
    occurred_at: new Date().toISOString(),
    page: { url: 'https://hmarquardt.github.io/junkdrawer/page.html', host: 'hmarquardt.github.io', path: '/junkdrawer/page.html', query: '', title: 'Test Page' },
    referrer: { url: 'https://example.com/ref', domain: 'example.com' },
    utm: { source: null, medium: null, campaign: null },
    client: { language: 'en-US', timezone: 'America/Indiana/Indianapolis', screen_width: 1440, screen_height: 900, viewport_width: 1200, viewport_height: 800, user_agent: 'Mozilla/5.0 Chrome/120 Safari/537.36' },
    performance: { load_time_ms: 120, navigation_type: 'navigate' },
    ...overrides,
  };
}
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.ANALYTICS, bindings.TEST_ANALYTICS_MIGRATIONS);
});
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.ANALYTICS.batch([
    bindings.ANALYTICS.prepare('DELETE FROM events'), bindings.ANALYTICS.prepare('DELETE FROM pageviews'),
    bindings.ANALYTICS.prepare('DELETE FROM sessions'), bindings.ANALYTICS.prepare('DELETE FROM visitors'),
  ]);
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM password_reset_tokens'), bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM project_memberships'), bindings.DB.prepare('DELETE FROM users'),
    bindings.DB.prepare('DELETE FROM files'), bindings.DB.prepare('DELETE FROM records'), bindings.DB.prepare('DELETE FROM apps'),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map(object => object.key));
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('top-hat-ferals', 'Top Hat Ferals', 1, '{}', ?, ?)").bind(now, now),
    bindings.DB.prepare("INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('wildlife-field-recorder', 'Wildlife Field Recorder', 1, '{}', ?, ?)").bind(now, now),
    bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .bind(topHatSightingId, 'top-hat-ferals', 'sightings', JSON.stringify({ cat_name: 'Test Cat', date: '2026-05-08', note: 'public sighting' }), now, now),
    bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .bind('44444444-4444-4444-8444-444444444444', 'wildlife-field-recorder', 'observations', JSON.stringify({ localId: 'private', latitude: 39.1, longitude: -86.2 }), now, now),
  ]);
  await bindings.FILES.put('apps/top-hat-ferals/files/tophat.jpg', 'tophat-image', { httpMetadata: { contentType: 'image/jpeg' } });
  await bindings.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
    .bind(topHatImageId, 'top-hat-ferals', 'apps/top-hat-ferals/files/tophat.jpg', 'cat.jpg', 'image/jpeg', 12, now, 'sightings', topHatSightingId).run();
  await bindings.FILES.put('apps/wildlife-field-recorder/files/private.jpg', 'private-image', { httpMetadata: { contentType: 'image/jpeg' } });
  await bindings.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
    .bind(wildlifeImageId, 'wildlife-field-recorder', 'apps/wildlife-field-recorder/files/private.jpg', 'private.jpg', 'image/jpeg', 13, now, 'observations', '44444444-4444-4444-8444-444444444444').run();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Top Hat Ferals public projection', () => {
  it('serves public sightings with photos and empty cats/interactions', async () => {
    const sightings = await call('/api/public/top-hat-ferals/sightings', 'GET', undefined, null, { Origin: tophatOrigin });
    expect(sightings.status).toBe(200);
    expect(sightings.headers.get('Access-Control-Allow-Origin')).toBe(tophatOrigin);
    const body = await sightings.json<{ records: Array<{ id: string; data: Record<string, unknown>; photos: Array<{ id: string; url: string }> }>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.records[0]).toMatchObject({ id: topHatSightingId, data: { cat_name: 'Test Cat' } });
    expect(body.records[0]?.photos[0]).toMatchObject({ id: topHatImageId });
    for (const resource of ['cats', 'interactions']) {
      const response = await call(`/api/public/top-hat-ferals/${resource}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ records: [], total: 0 });
    }
  });
  it('never exposes other apps and rejects unsupported resources', async () => {
    const text = await (await call('/api/public/top-hat-ferals/sightings')).text();
    expect(text).not.toContain('wildlife-field-recorder');
    expect(text).not.toContain('39.1');
    expect((await call('/api/public/top-hat-ferals/observations')).status).toBe(404);
    expect((await call('/api/public/top-hat-ferals/records')).status).toBe(404);
    expect((await call('/api/public/top-hat-ferals/sightings', 'POST')).status).toBe(404);
  });
  it('serves only Top Hat image files', async () => {
    const image = await call(`/api/public/top-hat-ferals/files/${topHatImageId}`, 'GET', undefined, null, { Origin: tophatOrigin });
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new TextDecoder().decode(await image.arrayBuffer())).toBe('tophat-image');
    expect((await call(`/api/public/top-hat-ferals/files/${wildlifeImageId}`)).status).toBe(404);
    expect((await call('/api/public/top-hat-ferals/files/not-a-uuid')).status).toBe(404);
  });
  it('serves the public projection through either production hostname', async () => {
    const response = await local.fetch(new Request('https://lab.aismallbizguru.com/api/public/top-hat-ferals/sightings'), testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1 });
    const cflabResponse = await local.fetch(new Request('https://cflab.aismallbizguru.com/api/public/top-hat-ferals/sightings'), testEnv);
    expect(await cflabResponse.json()).toMatchObject({ total: 1 });
  });
  it('returns newest linked image first and hides archived sightings', async () => {
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const now = new Date();
    const olderAt = new Date(now.getTime() - 60_000).toISOString();
    const newerAt = now.toISOString();
    for (const [id, at] of [[older, olderAt], [newer, newerAt]] as const) {
      await bindings.FILES.put(`apps/top-hat-ferals/files/${id}`, 'image-bytes', { httpMetadata: { contentType: 'image/jpeg' } });
      await bindings.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
        .bind(id, 'top-hat-ferals', `apps/top-hat-ferals/files/${id}`, `${id}.jpg`, 'image/jpeg', 11, at, 'sightings', topHatSightingId).run();
    }
    const projection = await (await call('/api/public/top-hat-ferals/sightings')).json<{ records: Array<{ photos: Array<{ id: string }> }> }>();
    expect(projection.records[0]?.photos[0]?.id).toBe(newer);
    const ids = projection.records[0]?.photos.map(photo => photo.id) ?? [];
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    const nowIso = new Date().toISOString();
    await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .bind(crypto.randomUUID(), 'archive-admin@example.com', await hashPassword(password), nowIso, nowIso).run();
    const archiveLogin = await call('/api/auth/login', 'POST', { email: 'archive-admin@example.com', password });
    const archiveToken = (await archiveLogin.json<{ token: string }>()).token;
    expect((await call(`/api/apps/top-hat-ferals/resources/sightings/records/${topHatSightingId}`, 'DELETE', undefined, archiveToken)).status).toBe(204);
    const after = await (await call('/api/public/top-hat-ferals/sightings')).json<{ total: number }>();
    expect(after.total).toBe(0);
  });
  it('rejects unlisted origins', async () => {
    expect((await call('/api/public/top-hat-ferals/sightings', 'GET', undefined, null, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/public/top-hat-ferals/sightings')).status).toBe(200);
  });
});

describe('analytics collector and dashboard', () => {
  it('accepts a valid pageview and stores visitor, session, and pageview rows', async () => {
    const response = await call('/api/analytics/collect', 'POST', collectPayload(), null, { Origin: tophatOrigin });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM visitors').first('n')).toBe(1);
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(1);
    const pageview = await bindings.ANALYTICS.prepare('SELECT site_id, page_path, browser_name, device_type, is_bot, ip_hash FROM pageviews').first<{ site_id: string; page_path: string; browser_name: string; device_type: string; is_bot: number; ip_hash: string | null }>();
    expect(pageview).toMatchObject({ site_id: 'junkdrawer', page_path: '/junkdrawer/page.html', browser_name: 'Chrome', device_type: 'desktop', is_bot: 0, ip_hash: null });
  });
  it('rejects malformed, unknown-site, disallowed-origin, and oversized events', async () => {
    expect((await call('/api/analytics/collect', 'POST', collectPayload({ site_id: 'unknown' }))).status).toBe(404);
    expect((await call('/api/analytics/collect', 'POST', collectPayload({ event_type: 'hack' }))).status).toBe(400);
    expect((await call('/api/analytics/collect', 'POST', collectPayload({ visitor_id: '' }))).status).toBe(400);
    expect((await call('/api/analytics/collect', 'POST', collectPayload({ occurred_at: 'not-a-date' }))).status).toBe(400);
    expect((await call('/api/analytics/collect', 'POST', collectPayload(), null, { Origin: 'https://evil.example' })).status).toBe(403);
    const big = collectPayload({ props: { text: 'x'.repeat(40_000) } });
    expect((await call('/api/analytics/collect', 'POST', big)).status).toBe(413);
    const raw = await local.fetch(new Request('http://localhost/api/analytics/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), testEnv);
    expect(raw.status).toBe(400);
  });
  it('stores event payloads with bound parameters and flags bots', async () => {
    await call('/api/analytics/collect', 'POST', collectPayload({ event_type: 'event', event_name: "quote'name", props: { note: "'; DROP TABLE pageviews; --" } }));
    const event = await bindings.ANALYTICS.prepare('SELECT event_name, props_json FROM events').first<{ event_name: string; props_json: string }>();
    expect(event?.event_name).toBe("quote'name");
    expect(event?.props_json).toContain("DROP TABLE");
    await call('/api/analytics/collect', 'POST', collectPayload({ visitor_id: 'v_bot', session_id: 's_bot', client: { user_agent: 'Googlebot/2.1' } }));
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM pageviews WHERE is_bot = 1').first('n')).toBe(1);
  });
  it('enforces the analytics rate limit', async () => {
    const limited = { ...testEnv, RL_ANALYTICS: { limit: async () => ({ success: false }) } } as unknown as Bindings;
    const response = await local.fetch(new Request('http://localhost/api/analytics/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectPayload()) }), limited);
    expect(response.status).toBe(429);
  });
  it('requires an admin human session for dashboard queries and returns legacy shapes', async () => {
    expect((await call('/api/analytics/summary?site_id=junkdrawer&from=2026-01-01&to=2026-12-31')).status).toBe(401);
    const now = new Date().toISOString();
    const adminId = crypto.randomUUID();
    await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .bind(adminId, 'admin@example.com', await hashPassword(password), now, now).run();
    await call('/api/auth/login', 'POST', { email: 'admin@example.com', password });
    const login = await call('/api/auth/login', 'POST', { email: 'admin@example.com', password });
    const token = (await login.json<{ token: string }>()).token;
    await call('/api/analytics/collect', 'POST', collectPayload());
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const summary = await call(`/api/analytics/summary?site_id=junkdrawer&from=${from}&to=${to}`, 'GET', undefined, token);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ site_id: 'junkdrawer', pageviews: 1, visitors: 1, sessions: 1 });
    const timeseries = await call(`/api/analytics/timeseries?site_id=junkdrawer&from=${from}&to=${to}&bucket=day`, 'GET', undefined, token);
    expect((await timeseries.json<{ points: unknown[] }>()).points).toHaveLength(1);
    const pages = await call(`/api/analytics/pages?site_id=junkdrawer&from=${from}&to=${to}`, 'GET', undefined, token);
    expect((await pages.json<{ pages: Array<{ path: string }> }>()).pages[0]?.path).toBe('/junkdrawer/page.html');
    const referrers = await call(`/api/analytics/referrers?site_id=junkdrawer&from=${from}&to=${to}`, 'GET', undefined, token);
    expect((await referrers.json<{ referrers: Array<{ domain: string }> }>()).referrers[0]?.domain).toBe('example.com');
    const recent = await call('/api/analytics/recent?site_id=junkdrawer&limit=5', 'GET', undefined, token);
    expect((await recent.json<{ visits: unknown[] }>()).visits).toHaveLength(1);
    expect((await call('/api/analytics/summary?site_id=unknown&from=2026-01-01&to=2026-12-31', 'GET', undefined, token)).status).toBe(404);
    expect((await call('/api/analytics/summary?site_id=junkdrawer&from=2026-01-01&to=bad', 'GET', undefined, token)).status).toBe(400);
  });
});

describe('Top Hat Ferals origin registration and CORS', () => {
  beforeEach(async () => {
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('top-hat-ferals','https://tophatferals.com')"),
      bindings.DB.prepare("INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('top-hat-ferals','https://www.tophatferals.com')"),
      bindings.DB.prepare("INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('top-hat-ferals','https://tophatferals.com')"),
    ]);
  });
  it('registers both production origins idempotently and ships the seed in a migration', async () => {
    const { results } = await bindings.DB.prepare("SELECT origin FROM app_origins WHERE app_id = 'top-hat-ferals' ORDER BY origin").all<{ origin: string }>();
    expect(results.map(row => row.origin)).toEqual(['https://tophatferals.com', 'https://www.tophatferals.com']);
  });
  it('allows auth and app writes from Top Hat origins and rejects unrelated origins', async () => {
    const now = new Date().toISOString();
    await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .bind(crypto.randomUUID(), 'thf-admin@example.com', await hashPassword(password), now, now).run();
    const preflight = await call('/api/auth/login', 'OPTIONS', undefined, null, { Origin: 'https://tophatferals.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://tophatferals.com');
    const login = await call('/api/auth/login', 'POST', { email: 'thf-admin@example.com', password }, null, { Origin: 'https://www.tophatferals.com' });
    expect(login.status).toBe(200);
    expect(login.headers.get('Access-Control-Allow-Origin')).toBe('https://www.tophatferals.com');
    const token = (await login.json<{ token: string }>()).token;
    expect((await call('/api/auth/me', 'GET', undefined, token, { Origin: 'https://tophatferals.com' })).status).toBe(200);
    expect((await call('/api/auth/login', 'POST', { email: 'thf-admin@example.com', password: 'wrong password here' }, null, { Origin: 'https://tophatferals.com' })).status).toBe(401);
    expect((await call('/api/auth/login', 'POST', { email: 'thf-admin@example.com', password }, null, { Origin: 'https://evil.example' })).status).toBe(403);
    const records = '/api/apps/top-hat-ferals/resources/sightings/records';
    const appPreflight = await call(records, 'OPTIONS', undefined, null, { Origin: 'https://tophatferals.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' });
    expect(appPreflight.status).toBe(204);
    const create = await call(records, 'POST', { data: { cat_name: 'Origin Test', date: '2026-09-20' } }, token, { Origin: 'https://tophatferals.com' });
    expect(create.status).toBe(201);
    expect(create.headers.get('Access-Control-Allow-Origin')).toBe('https://tophatferals.com');
    const files = '/api/apps/top-hat-ferals/files';
    const uploadPreflight = await call(files, 'OPTIONS', undefined, null, { Origin: 'https://www.tophatferals.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-filename,x-file-id,x-record-id,x-resource' });
    expect(uploadPreflight.status).toBe(204);
    const recordId = (await create.json<{ id: string }>()).id;
    const upload = await local.fetch(new Request(`http://localhost${files}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Filename': 'origin.jpg', 'X-File-Id': crypto.randomUUID(), 'X-Record-Id': recordId, 'X-Resource': 'sightings', Origin: 'https://www.tophatferals.com' }, body: new Uint8Array([1, 2, 3, 4]) }), testEnv);
    expect(upload.status).toBe(201);
    expect(upload.headers.get('Access-Control-Allow-Origin')).toBe('https://www.tophatferals.com');
  });
});

describe('JunkStats dashboard origin and admin API', () => {
  const dashboardOrigin = 'https://hmarquardt.github.io';
  async function createAdmin(email: string, isAdmin: boolean) {
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .bind(userId, email, await hashPassword(password), isAdmin ? 1 : 0, now, now).run();
    const login = await call('/api/auth/login', 'POST', { email, password }, null, { Origin: dashboardOrigin });
    expect(login.status).toBe(200);
    return (await login.json<{ token: string }>()).token;
  }
  beforeEach(async () => {
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('junkstats-dashboard', 'JunkStats Dashboard', 1, '{}', datetime('now'), datetime('now'))"),
      bindings.DB.prepare("INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('junkstats-dashboard', 'https://hmarquardt.github.io')"),
      bindings.DB.prepare("INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('junkstats-dashboard', 'https://hmarquardt.github.io')"),
    ]);
  });
  it('registers the dashboard app origin idempotently and ships the seed in a migration', async () => {
    const { results } = await bindings.DB.prepare("SELECT origin FROM app_origins WHERE app_id = 'junkstats-dashboard'").all<{ origin: string }>();
    expect(results).toEqual([{ origin: dashboardOrigin }]);
  });
  it('allows dashboard-origin auth and rejects wrong credentials and unrelated origins', async () => {
    const now = new Date().toISOString();
    await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .bind(crypto.randomUUID(), 'dash-admin@example.com', await hashPassword(password), now, now).run();
    const preflight = await call('/api/auth/login', 'OPTIONS', undefined, null, { Origin: dashboardOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(dashboardOrigin);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    const login = await call('/api/auth/login', 'POST', { email: 'dash-admin@example.com', password }, null, { Origin: dashboardOrigin });
    expect(login.status).toBe(200);
    expect(login.headers.get('Access-Control-Allow-Origin')).toBe(dashboardOrigin);
    const token = (await login.json<{ token: string }>()).token;
    expect((await call('/api/auth/me', 'GET', undefined, token, { Origin: dashboardOrigin })).status).toBe(200);
    expect((await call('/api/auth/login', 'POST', { email: 'dash-admin@example.com', password: 'wrong password here' }, null, { Origin: dashboardOrigin })).status).toBe(401);
    expect((await call('/api/auth/login', 'POST', { email: 'dash-admin@example.com', password }, null, { Origin: 'https://evil.example' })).status).toBe(403);
  });
  it('serves all five analytics panels to an admin session from the dashboard origin and denies non-admins', async () => {
    const adminToken = await createAdmin('dash-admin@example.com', true);
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    for (const path of ['summary', 'timeseries', 'pages', 'referrers', 'recent']) {
      const response = await call(`/api/analytics/${path}?site_id=junkdrawer&from=${from}&to=${to}`, 'GET', undefined, adminToken, { Origin: dashboardOrigin });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(dashboardOrigin);
    }
    const nonAdminToken = await createAdmin('dash-viewer@example.com', false);
    expect((await call(`/api/analytics/summary?site_id=junkdrawer&from=${from}&to=${to}`, 'GET', undefined, nonAdminToken, { Origin: dashboardOrigin })).status).toBe(403);
  });
});
