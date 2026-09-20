import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AnalyticsEnv, SiteRole } from './env';
import { ApiError, fields, jsonBody } from '../http';
import { authenticate, requireRole, siteRole } from './auth';
import { domainsForSite, findSiteByRef, primaryDomain, siteOutput, type DomainRow, type SiteRow } from './sites';
import { newPublicId, normalizeHostname, slugFromName, validSlug, validTimezone, cleanText } from './sanitize';
import { reporting } from './reporting';

const SITE_FIELDS = ['name', 'slug', 'timezone', 'active', 'respect_dnt', 'respect_gpc', 'raw_retention_days'];
const CANONICAL_ORIGIN = 'https://analytics.aismallbizguru.com';

export const sites = new Hono<AnalyticsEnv>();

sites.use('*', async (c, next) => {
  c.set('identity', await authenticate(c.env, c.req.header('Authorization')));
  await next();
});

const loadSite: MiddlewareHandler<AnalyticsEnv> = async (c, next) => {
  const ref = c.req.param('site') ?? '';
  const site = await findSiteByRef(c.env.ANALYTICS, ref);
  if (!site) throw new ApiError(404, 'site_not_found', 'Site not found');
  const role = await siteRole(c.env.ANALYTICS, site.id, c.get('identity'));
  if (!role) throw new ApiError(403, 'forbidden', 'Insufficient site access');
  c.set('site', site);
  c.set('role', role);
  await next();
};

sites.get('/', async c => {
  const identity = c.get('identity');
  if (identity.isAdmin) {
    const { results } = await c.env.ANALYTICS.prepare('SELECT * FROM analytics_sites ORDER BY name, id').all<SiteRow>();
    return c.json({ sites: results.map(site => siteOutput(site, 'owner')) });
  }
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT s.*, m.role AS role FROM analytics_sites s
     JOIN analytics_site_memberships m ON m.site_id = s.id
     WHERE m.user_id = ? ORDER BY s.name, s.id`).bind(identity.userId).all<SiteRow & { role: SiteRole }>();
  return c.json({ sites: results.map(site => siteOutput(site, site.role)) });
});

sites.post('/', async c => {
  const identity = c.get('identity');
  if (!identity.isAdmin) throw new ApiError(403, 'forbidden', 'Administrator access required');
  const body = await jsonBody(c.req.raw);
  fields(body, ['name', 'slug', 'timezone', 'domain', 'raw_retention_days']);
  const name = cleanText(body.name, 100);
  if (!name) throw new ApiError(400, 'invalid_input', 'Invalid name');
  const requestedSlug = body.slug === undefined ? null : validSlug(body.slug);
  if (body.slug !== undefined && !requestedSlug) throw new ApiError(400, 'invalid_input', 'Invalid slug');
  const slug = await uniqueSlug(c.env.ANALYTICS, requestedSlug ?? slugFromName(name));
  const timezone = body.timezone === undefined ? 'UTC' : validTimezone(body.timezone);
  if (!timezone) throw new ApiError(400, 'invalid_input', 'Invalid timezone');
  const retention = body.raw_retention_days === undefined ? 90 : Number(body.raw_retention_days);
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) throw new ApiError(400, 'invalid_input', 'Invalid retention');
  const now = Date.now();
  const publicId = newPublicId();
  const result = await c.env.ANALYTICS.prepare(
    `INSERT INTO analytics_sites (public_id, slug, name, timezone, active, respect_dnt, respect_gpc, raw_retention_days, created_by_user_id, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?)`)
    .bind(publicId, slug, name, timezone, retention, identity.userId, now, now).run();
  const siteId = Number(result.meta.last_row_id);
  if (body.domain !== undefined) {
    const hostname = normalizeHostname(body.domain);
    if (!hostname) throw new ApiError(400, 'invalid_input', 'Invalid domain');
    await c.env.ANALYTICS.prepare(
      `INSERT INTO analytics_domains (site_id, hostname, kind, active, verified_at_ms, created_at_ms) VALUES (?, ?, 'primary', 1, NULL, ?)`)
      .bind(siteId, hostname, now).run();
  }
  const site = await findSiteByRef(c.env.ANALYTICS, publicId);
  return c.json({ site: siteOutput(site!, 'owner'), domains: await domainsForSite(c.env.ANALYTICS, siteId) }, 201);
});

sites.use('/:site/*', loadSite);
sites.use('/:site', loadSite);
sites.route('/:site', reporting);

sites.get('/:site', async c => {
  const site = c.get('site');
  const last = await c.env.ANALYTICS.prepare('SELECT MAX(received_at_ms) AS last_event_at_ms FROM analytics_events WHERE site_id = ?')
    .bind(site.id).first<{ last_event_at_ms: number | null }>();
  return c.json({
    site: siteOutput(site, c.get('role')),
    domains: await domainsForSite(c.env.ANALYTICS, site.id),
    last_event_at_ms: last?.last_event_at_ms ?? null,
  });
});

sites.patch('/:site', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const body = await jsonBody(c.req.raw);
  fields(body, SITE_FIELDS);
  const updates: { column: string; value: string | number }[] = [];
  if (body.name !== undefined) {
    const name = cleanText(body.name, 100);
    if (!name) throw new ApiError(400, 'invalid_input', 'Invalid name');
    updates.push({ column: 'name', value: name });
  }
  if (body.slug !== undefined) {
    const slug = validSlug(body.slug);
    if (!slug) throw new ApiError(400, 'invalid_input', 'Invalid slug');
    const taken = await c.env.ANALYTICS.prepare('SELECT 1 FROM analytics_sites WHERE slug = ? AND id <> ?').bind(slug, site.id).first();
    if (taken) throw new ApiError(409, 'slug_taken', 'Slug already in use');
    updates.push({ column: 'slug', value: slug });
  }
  if (body.timezone !== undefined) {
    const timezone = validTimezone(body.timezone);
    if (!timezone) throw new ApiError(400, 'invalid_input', 'Invalid timezone');
    updates.push({ column: 'timezone', value: timezone });
  }
  for (const key of ['active', 'respect_dnt', 'respect_gpc'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new ApiError(400, 'invalid_input', 'Expected a boolean');
      updates.push({ column: key, value: body[key] ? 1 : 0 });
    }
  }
  if (body.raw_retention_days !== undefined) {
    const retention = Number(body.raw_retention_days);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650) throw new ApiError(400, 'invalid_input', 'Invalid retention');
    updates.push({ column: 'raw_retention_days', value: retention });
  }
  if (updates.length) {
    const assignments = updates.map(update => `${update.column} = ?`).join(', ');
    await c.env.ANALYTICS.prepare(`UPDATE analytics_sites SET ${assignments}, updated_at_ms = ? WHERE id = ?`)
      .bind(...updates.map(update => update.value), Date.now(), site.id).run();
  }
  const updated = await findSiteByRef(c.env.ANALYTICS, site.public_id);
  return c.json({ site: siteOutput(updated!, c.get('role')) });
});

sites.get('/:site/domains', async c => {
  return c.json({ domains: await domainsForSite(c.env.ANALYTICS, c.get('site').id) });
});

sites.post('/:site/domains', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const body = await jsonBody(c.req.raw);
  fields(body, ['hostname', 'kind']);
  const hostname = normalizeHostname(body.hostname);
  if (!hostname) throw new ApiError(400, 'invalid_input', 'Invalid hostname');
  const kind = body.kind === undefined ? 'alias' : body.kind;
  if (kind !== 'primary' && kind !== 'alias') throw new ApiError(400, 'invalid_input', 'Invalid domain kind');
  const existing = await c.env.ANALYTICS.prepare('SELECT 1 FROM analytics_domains WHERE site_id = ? AND hostname = ?')
    .bind(site.id, hostname).first();
  if (existing) throw new ApiError(409, 'domain_exists', 'Domain already registered');
  const primary = kind === 'primary' ? null : await primaryDomain(c.env.ANALYTICS, site.id);
  const finalKind = primary ? 'alias' : kind;
  const result = await c.env.ANALYTICS.prepare(
    'INSERT INTO analytics_domains (site_id, hostname, kind, active, verified_at_ms, created_at_ms) VALUES (?, ?, ?, 1, NULL, ?)')
    .bind(site.id, hostname, finalKind, Date.now()).run();
  const domain = await c.env.ANALYTICS.prepare('SELECT * FROM analytics_domains WHERE id = ?')
    .bind(Number(result.meta.last_row_id)).first<DomainRow>();
  return c.json({ domain }, 201);
});

sites.delete('/:site/domains/:domain', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const hostname = normalizeHostname(c.req.param('domain'));
  if (!hostname) throw new ApiError(400, 'invalid_input', 'Invalid hostname');
  const domain = await c.env.ANALYTICS.prepare('SELECT id FROM analytics_domains WHERE site_id = ? AND hostname = ?')
    .bind(site.id, hostname).first<{ id: number }>();
  if (!domain) throw new ApiError(404, 'domain_not_found', 'Domain not found');
  // Deactivate rather than delete: events keep their domain reference.
  await c.env.ANALYTICS.prepare('UPDATE analytics_domains SET active = 0 WHERE id = ?').bind(domain.id).run();
  return c.body(null, 204);
});

sites.get('/:site/snippet', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'editor');
  const snippet = `<script defer src="${CANONICAL_ORIGIN}/script.js" data-site="${site.public_id}"></script>`;
  return c.json({ site: site.public_id, script: `${CANONICAL_ORIGIN}/script.js`, endpoint: `${CANONICAL_ORIGIN}/collect`, snippet });
});

sites.get('/:site/members', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const { results } = await c.env.ANALYTICS.prepare(
    'SELECT user_id, role, created_at_ms FROM analytics_site_memberships WHERE site_id = ? ORDER BY created_at_ms, user_id')
    .bind(site.id).all<{ user_id: string; role: SiteRole; created_at_ms: number }>();
  return c.json({ members: results });
});

sites.put('/:site/members/:userId', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const userId = cleanText(c.req.param('userId'), 64);
  if (!userId) throw new ApiError(400, 'invalid_input', 'Invalid user id');
  const body = await jsonBody(c.req.raw);
  fields(body, ['role']);
  const role = body.role;
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') throw new ApiError(400, 'invalid_input', 'Invalid role');
  await c.env.ANALYTICS.prepare(
    `INSERT INTO analytics_site_memberships (site_id, user_id, role, created_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, user_id) DO UPDATE SET role = excluded.role`)
    .bind(site.id, userId, role, Date.now()).run();
  return c.json({ member: { user_id: userId, role } });
});

sites.delete('/:site/members/:userId', async c => {
  const site = c.get('site');
  requireRole(c.get('role'), 'owner');
  const userId = cleanText(c.req.param('userId'), 64);
  if (!userId) throw new ApiError(400, 'invalid_input', 'Invalid user id');
  await c.env.ANALYTICS.prepare('DELETE FROM analytics_site_memberships WHERE site_id = ? AND user_id = ?')
    .bind(site.id, userId).run();
  return c.body(null, 204);
});

async function uniqueSlug(db: D1Database, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 60)}-${attempt}`;
    const existing = await db.prepare('SELECT 1 FROM analytics_sites WHERE slug = ?').bind(candidate).first();
    if (!existing) return candidate;
  }
  return `${base.slice(0, 55)}-${crypto.randomUUID().slice(0, 4)}`;
}
