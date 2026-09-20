import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JUNKDRAWER, bindings, call, migrate, resetData, seedHuman } from './helpers';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
});

async function admin() {
  return await seedHuman(`admin-${crypto.randomUUID()}@example.com`, true);
}

function json(path: string, method: string, body: unknown, token: string) {
  return call(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

describe('site management', () => {
  it('creates a site with an opaque immutable public id and a primary domain', async () => {
    const token = await admin();
    const response = await json('/api/sites', 'POST', { name: 'My Blog', slug: 'my-blog', domain: 'blog.example.com', timezone: 'America/New_York' }, token);
    expect(response.status).toBe(201);
    const body = await response.json<{ site: { public_id: string; legacy_key: string | null; slug: string }; domains: Array<{ hostname: string; kind: string }> }>();
    expect(body.site.public_id).toMatch(/^as_[A-Za-z0-9]{22}$/);
    expect(body.site.legacy_key).toBeNull();
    expect(body.site.slug).toBe('my-blog');
    expect(body.domains).toEqual([expect.objectContaining({ hostname: 'blog.example.com', kind: 'primary' })]);
    const detail = await call(`/api/sites/${body.site.public_id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await detail.json<{ site: { public_id: string } }>()).site.public_id).toBe(body.site.public_id);
  });

  it('requires a global admin to create sites and rejects invalid input', async () => {
    const token = await admin();
    const userToken = await seedHuman('user@example.com', false);
    expect((await json('/api/sites', 'POST', { name: 'Nope' }, userToken)).status).toBe(403);
    expect((await json('/api/sites', 'POST', { name: 'Bad TZ', timezone: 'Mars/Phobos' }, token)).status).toBe(400);
    expect((await json('/api/sites', 'POST', { name: 'Bad Domain', domain: 'not a domain' }, token)).status).toBe(400);
    expect((await json('/api/sites', 'POST', { name: 'Bad Slug', slug: 'Not A Slug' }, token)).status).toBe(400);
  });

  it('generates unique slugs when names collide', async () => {
    const token = await admin();
    const first = await json('/api/sites', 'POST', { name: 'Same Name' }, token);
    const second = await json('/api/sites', 'POST', { name: 'Same Name' }, token);
    expect((await first.json<{ site: { slug: string } }>()).site.slug).toBe('same-name');
    expect((await second.json<{ site: { slug: string } }>()).site.slug).toBe('same-name-2');
  });

  it('keeps public_id and legacy_key immutable through PATCH', async () => {
    const token = await admin();
    const created = await json('/api/sites', 'POST', { name: 'Immutable' }, token);
    const publicId = (await created.json<{ site: { public_id: string } }>()).site.public_id;
    expect((await json(`/api/sites/${publicId}`, 'PATCH', { public_id: 'as_aaaaaaaaaaaaaaaaaaaaaa' }, token)).status).toBe(400);
    expect((await json(`/api/sites/${publicId}`, 'PATCH', { legacy_key: 'hijack' }, token)).status).toBe(400);
    const patched = await json(`/api/sites/${publicId}`, 'PATCH', { name: 'Renamed', respect_dnt: false }, token);
    expect(patched.status).toBe(200);
    const body = await patched.json<{ site: { public_id: string; name: string; respect_dnt: boolean } }>();
    expect(body.site).toMatchObject({ public_id: publicId, name: 'Renamed', respect_dnt: false });
  });

  it('resolves seeded sites by legacy key', async () => {
    const token = await admin();
    const response = await call(`/api/sites/${JUNKDRAWER}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json<{ site: { legacy_key: string; public_id: string } }>();
    expect(body.site).toMatchObject({ legacy_key: 'junkdrawer', public_id: JUNKDRAWER });
    const byLegacy = await call('/api/sites/junkdrawer', { headers: { Authorization: `Bearer ${token}` } });
    expect((await byLegacy.json<{ site: { public_id: string } }>()).site.public_id).toBe(JUNKDRAWER);
  });

  it('adds, deactivates, and scopes domains to a site', async () => {
    const token = await admin();
    const base = `/api/sites/${JUNKDRAWER}/domains`;
    expect((await json(base, 'POST', { hostname: 'new.example.com' }, token)).status).toBe(201);
    expect((await json(base, 'POST', { hostname: 'new.example.com' }, token)).status).toBe(409);
    const other = await json('/api/sites', 'POST', { name: 'Other' }, token);
    const otherId = (await other.json<{ site: { public_id: string } }>()).site.public_id;
    expect((await json(`/api/sites/${otherId}/domains`, 'POST', { hostname: 'new.example.com' }, token)).status).toBe(201);
    expect((await call(`${base}/new.example.com`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
    const row = await bindings.ANALYTICS.prepare('SELECT active FROM analytics_domains WHERE site_id = 1 AND hostname = ?').bind('new.example.com').first<{ active: number }>();
    expect(row?.active).toBe(0);
  });

  it('generates the canonical tracking snippet', async () => {
    const token = await admin();
    const response = await call(`/api/sites/${JUNKDRAWER}/snippet`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json<{ snippet: string; endpoint: string }>();
    expect(body.snippet).toContain('https://analytics.aismallbizguru.com/script.js');
    expect(body.snippet).toContain(`data-site="${JUNKDRAWER}"`);
    expect(body.endpoint).toBe('https://analytics.aismallbizguru.com/collect');
  });

  it('manages memberships', async () => {
    const token = await admin();
    const userId = crypto.randomUUID();
    const base = `/api/sites/${JUNKDRAWER}/members`;
    expect((await json(`${base}/${userId}`, 'PUT', { role: 'viewer' }, token)).status).toBe(200);
    expect((await json(`${base}/${userId}`, 'PUT', { role: 'editor' }, token)).status).toBe(200);
    const list = await (await call(base, { headers: { Authorization: `Bearer ${token}` } })).json<{ members: Array<{ user_id: string; role: string }> }>();
    expect(list.members).toEqual([{ user_id: userId, role: 'editor', created_at_ms: expect.any(Number) }]);
    expect((await json(`${base}/${userId}`, 'PUT', { role: 'admin' }, token)).status).toBe(400);
    expect((await call(`${base}/${userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
    const after = await (await call(base, { headers: { Authorization: `Bearer ${token}` } })).json<{ members: unknown[] }>();
    expect(after.members).toHaveLength(0);
  });
});
