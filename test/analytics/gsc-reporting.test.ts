import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindings, call, migrate, resetData, seedHuman, seedMembership, testEnv, userIdForToken } from './helpers';
import { GSC_PROPERTIES } from '../../src/analytics/gsc-properties';
import type { AnalyticsBindings } from '../../src/analytics/env';

const SLUG = 'fruitingforecast';
const PROPERTY = 'sc-domain:fruitingforecast.com';
const OTHER_PROPERTY = 'sc-domain:worthlookingup.com';
const SECRET = '{"client_email":"never-return-this@project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----secret"}';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
  await seedSearchSite();
});
afterEach(() => { vi.restoreAllMocks(); });

async function seedSearchSite(): Promise<number> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO analytics_sites
       (public_id, slug, name, timezone, active, respect_dnt, respect_gpc, raw_retention_days, created_by_user_id, created_at_ms, updated_at_ms)
     VALUES ('as_search_test', ?, 'Fruiting Forecast', 'UTC', 1, 1, 1, 90, 'system:test', ?, ?)
     ON CONFLICT(slug) DO NOTHING`)
    .bind(SLUG, Date.now(), Date.now()).run();
  const site = await bindings.ANALYTICS.prepare('SELECT id FROM analytics_sites WHERE slug = ?').bind(SLUG).first<{ id: number }>();
  return Number(site!.id);
}

async function seedProperty(overrides: { property?: string; siteId?: number | null; error?: string | null } = {}): Promise<void> {
  const property = overrides.property ?? PROPERTY;
  await bindings.ANALYTICS.prepare(
    `INSERT INTO gsc_properties
       (property, property_kind, hostname, label, site_id, permission_level, active, backfill_cursor, backfill_complete,
        last_attempt_at, last_success_at, last_error_code, days_covered, newest_day, first_incomplete_day, created_at_ms, updated_at_ms)
     VALUES (?, 'domain', 'fruitingforecast.com', 'Fruiting Forecast', ?, 'siteRestrictedUser', 1, '2025-07-05', 0,
             '2026-10-27T12:00:00.000Z', '2026-10-27T12:00:00.000Z', ?, 4, '2026-10-26', '2026-10-25', ?, ?)
     ON CONFLICT(property) DO NOTHING`)
    .bind(property, overrides.siteId === undefined ? await seedSearchSite() : overrides.siteId,
      overrides.error ?? null, Date.now(), Date.now()).run();
}

async function seedDay(property: string, day: string, clicks: number, impressions: number, position: number | null, state = 'final'): Promise<void> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO gsc_daily_totals (property, search_type, report_day, clicks, impressions, ctr, position, data_state, collected_at_ms)
     VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(property, search_type, report_day) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
       ctr = excluded.ctr, position = excluded.position, data_state = excluded.data_state`)
    .bind(property, day, clicks, impressions, impressions > 0 ? clicks / impressions : 0, position, state, Date.now()).run();
}

async function seedQuery(property: string, day: string, query: string, clicks: number, impressions: number, position: number): Promise<void> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO gsc_query_daily (property, search_type, report_day, query_text, clicks, impressions, ctr, position, collected_at_ms)
     VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(property, day, query, clicks, impressions, clicks / impressions, position, Date.now()).run();
}

async function seedPage(property: string, day: string, page: string, clicks: number, impressions: number, position: number): Promise<void> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO gsc_page_daily (property, search_type, report_day, page_url, clicks, impressions, ctr, position, collected_at_ms)
     VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(property, day, page, clicks, impressions, clicks / impressions, position, Date.now()).run();
}

async function seedBreakdown(property: string, day: string, dimension: 'device' | 'country', value: string, clicks: number, impressions: number): Promise<void> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO gsc_breakdown_daily (property, search_type, report_day, dimension, value, clicks, impressions, ctr, position, collected_at_ms)
     VALUES (?, 'web', ?, ?, ?, ?, ?, ?, 4.5, ?)`)
    .bind(property, day, dimension, value, clicks, impressions, clicks / impressions, Date.now()).run();
}

async function tokenFor(isAdmin: boolean, member = true): Promise<string> {
  const token = await seedHuman(`search-${crypto.randomUUID()}@example.com`, isAdmin);
  if (member) {
    const siteId = await seedSearchSite();
    await seedMembership(siteId, await userIdForToken(token), 'viewer');
  }
  return token;
}

function get(path: string, token?: string, environment?: AnalyticsBindings) {
  return call(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, environment ?? testEnv());
}

const RANGE = 'from=2026-10-20&to=2026-10-26';

describe('Search Console report authorization', () => {
  it('rejects unauthenticated and non-member callers', async () => {
    await seedProperty();
    expect((await get(`/api/sites/${SLUG}/search/status`)).status).toBe(401);
    expect((await get(`/api/sites/${SLUG}/search/summary?${RANGE}`)).status).toBe(401);
    expect((await get(`/api/sites/${SLUG}/search/queries`)).status).toBe(401);
    const outsider = await tokenFor(false, false);
    expect((await get(`/api/sites/${SLUG}/search/summary?${RANGE}`, outsider)).status).toBe(403);
  });

  it('lets a site viewer read every search report', async () => {
    await seedProperty();
    const token = await tokenFor(false);
    for (const report of ['status', 'summary', 'timeseries', 'queries', 'pages', 'breakdowns']) {
      const response = await get(`/api/sites/${SLUG}/search/${report}?${RANGE}`, token);
      expect(response.status).toBe(200);
    }
  });

  it('never accepts a property that is not mapped to the requesting site', async () => {
    await seedProperty();
    await seedProperty({ property: OTHER_PROPERTY, siteId: null });
    const token = await tokenFor(true);
    const unknown = await get(`/api/sites/${SLUG}/search/summary?${RANGE}&property=${encodeURIComponent('sc-domain:example.com')}`, token);
    expect(unknown.status).toBe(400);
    // A real property that belongs elsewhere is still rejected for this site.
    const foreign = await get(`/api/sites/${SLUG}/search/summary?${RANGE}&property=${encodeURIComponent(OTHER_PROPERTY)}`, token);
    expect(foreign.status).toBe(400);
  });

  it('answers 404 for a Site with no reviewed Search Console property', async () => {
    // top-hat-ferals is a real Site in the test database, but no reviewed
    // Search Console property maps to that slug.
    const token = await tokenFor(true);
    const summary = await get(`/api/sites/top-hat-ferals/search/summary?${RANGE}`, token);
    expect(summary.status).toBe(404);
    expect(await summary.json()).toMatchObject({ error: { code: 'search_not_mapped' } });
    const status = await (await get('/api/sites/top-hat-ferals/search/status', token))
      .json<{ properties: unknown[]; configured: boolean }>();
    expect(status.properties).toEqual([]);
  });

  it('describes a mapped Site that has not collected anything yet without inventing data', async () => {
    const token = await tokenFor(false);
    const summary = await (await get(`/api/sites/${SLUG}/search/summary?${RANGE}`, token))
      .json<{ totals: { clicks: number; days: number }; freshness: { covered_days: number; missing_days: number } }>();
    expect(summary.totals).toMatchObject({ clicks: 0, days: 0 });
    expect(summary.freshness).toMatchObject({ covered_days: 0, missing_days: 7 });
    const status = await (await get(`/api/sites/${SLUG}/search/status`, token))
      .json<{ properties: { property: string; last_success_at: string | null }[]; sync: { last_success_at: string | null } }>();
    expect(status.properties.map(item => item.property)).toEqual([PROPERTY]);
    expect(status.properties[0]!.last_success_at).toBeNull();
    expect(status.sync.last_success_at).toBeNull();
  });

  it('never exposes the service-account secret', async () => {
    const token = await tokenFor(true);
    await seedProperty();
    const environment = testEnv({ GSC_SERVICE_ACCOUNT_JSON: SECRET });
    const responses = await Promise.all([
      get(`/api/sites/${SLUG}/search/status`, token, environment),
      get(`/api/sites/${SLUG}/search/summary?${RANGE}`, token, environment),
      get('/api/gsc/status', token, environment),
    ]);
    expect(await (await get(`/api/sites/${SLUG}/search/status`, token, environment)).json())
      .toMatchObject({ configured: true });
    const text = (await Promise.all(responses.map(response => response.text()))).join('\n');
    expect(text).not.toContain('never-return-this');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).not.toContain('client_email');
  });
});

describe('Search Console aggregates', () => {
  beforeEach(async () => {
    await seedProperty();
    await seedDay(PROPERTY, '2026-10-26', 5, 200, 6.4, 'provisional');
    await seedDay(PROPERTY, '2026-10-25', 3, 120, 7.1);
    await seedDay(PROPERTY, '2026-10-24', 1, 40, 9.5);
    // One day of the preceding equal-length window.
    await seedDay(PROPERTY, '2026-10-19', 2, 50, 8);
  });

  it('computes CTR from sums and position weighted by impressions', async () => {
    const token = await tokenFor(false);
    const body = await (await get(`/api/sites/${SLUG}/search/summary?${RANGE}`, token))
      .json<{ totals: Record<string, number | null>; previous: Record<string, number | null> }>();
    expect(body.totals.clicks).toBe(9);
    expect(body.totals.impressions).toBe(360);
    expect(body.totals.ctr).toBeCloseTo(0.025, 6);
    // (6.4*200 + 7.1*120 + 9.5*40) / 360 — never the mean of the three ranks.
    expect(body.totals.position).toBeCloseTo(2512 / 360, 6);
    expect(body.totals.days).toBe(3);
    expect(body.totals.provisional_days).toBe(1);
    expect(body.previous.clicks).toBe(2);
    expect(body.previous.position).toBe(8);
  });

  it('reports coverage gaps instead of inventing zero days', async () => {
    const token = await tokenFor(false);
    const body = await (await get(`/api/sites/${SLUG}/search/summary?${RANGE}`, token))
      .json<{ freshness: Record<string, number | string | null> }>();
    expect(body.freshness.covered_days).toBe(3);
    expect(body.freshness.requested_days).toBe(7);
    expect(body.freshness.missing_days).toBe(4);
    expect(body.freshness.newest_day).toBe('2026-10-26');
    expect(body.freshness.provisional_days).toBe(1);
    expect(body.freshness.last_success_at).toBe('2026-10-27T12:00:00.000Z');
  });

  it('returns a daily series with the freshness of each day', async () => {
    const token = await tokenFor(false);
    const body = await (await get(`/api/sites/${SLUG}/search/timeseries?${RANGE}`, token))
      .json<{ points: { date: string; clicks: number; impressions: number; data_state: string }[] }>();
    expect(body.points.map(point => point.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(body.points[2]).toMatchObject({ clicks: 5, impressions: 200, data_state: 'provisional' });
  });

  it('aggregates top queries and landing pages over the range', async () => {
    await seedQuery(PROPERTY, '2026-10-26', 'fruiting forecast', 4, 100, 3);
    await seedQuery(PROPERTY, '2026-10-25', 'fruiting forecast', 2, 50, 5);
    await seedQuery(PROPERTY, '2026-10-25', 'mushroom map', 1, 20, 9);
    await seedPage(PROPERTY, '2026-10-26', 'https://fruitingforecast.com/', 4, 100, 3);
    await seedPage(PROPERTY, '2026-10-25', 'https://fruitingforecast.com/guide', 2, 50, 7);
    const token = await tokenFor(false);

    const queries = await (await get(`/api/sites/${SLUG}/search/queries?${RANGE}&limit=10`, token))
      .json<{ queries: { query: string; clicks: number; impressions: number; ctr: number; position: number | null }[] }>();
    expect(queries.queries.map(row => row.query)).toEqual(['fruiting forecast', 'mushroom map']);
    expect(queries.queries[0]).toMatchObject({ clicks: 6, impressions: 150, ctr: 0.04 });
    // (3*100 + 5*50) / 150
    expect(queries.queries[0]!.position).toBeCloseTo(550 / 150, 6);

    const pages = await (await get(`/api/sites/${SLUG}/search/pages?${RANGE}`, token))
      .json<{ pages: { page: string; clicks: number }[] }>();
    expect(pages.pages.map(row => row.page)).toEqual(['https://fruitingforecast.com/', 'https://fruitingforecast.com/guide']);
    expect(pages.pages[0]!.clicks).toBe(4);
  });

  it('returns device and country breakdowns separately', async () => {
    await seedBreakdown(PROPERTY, '2026-10-26', 'device', 'MOBILE', 3, 100);
    await seedBreakdown(PROPERTY, '2026-10-26', 'device', 'DESKTOP', 2, 100);
    await seedBreakdown(PROPERTY, '2026-10-26', 'country', 'USA', 4, 150);
    await seedBreakdown(PROPERTY, '2026-10-26', 'country', 'CAN', 1, 50);
    const token = await tokenFor(false);
    const body = await (await get(`/api/sites/${SLUG}/search/breakdowns?${RANGE}`, token))
      .json<{ devices: { value: string; clicks: number }[]; countries: { value: string; clicks: number }[] }>();
    expect(body.devices.map(row => row.value)).toEqual(['MOBILE', 'DESKTOP']);
    expect(body.countries.map(row => row.value)).toEqual(['USA', 'CAN']);
  });

  it('validates the range and limit parameters', async () => {
    const token = await tokenFor(false);
    expect((await get(`/api/sites/${SLUG}/search/summary?from=2026-10-26&to=2026-10-20`, token)).status).toBe(400);
    expect((await get(`/api/sites/${SLUG}/search/summary?from=nope&to=2026-10-20`, token)).status).toBe(400);
    expect((await get(`/api/sites/${SLUG}/search/summary?from=2020-01-01&to=2026-10-20`, token)).status).toBe(400);
    expect((await get(`/api/sites/${SLUG}/search/queries?${RANGE}&limit=0`, token)).status).toBe(400);
    expect((await get(`/api/sites/${SLUG}/search/queries?${RANGE}&limit=101`, token)).status).toBe(400);
  });

  it('reports the reverse error only for administrators and only with the expected shape', async () => {
    const viewer = await tokenFor(false);
    expect((await get('/api/gsc/status', viewer)).status).toBe(403);
    const admin = await tokenFor(true);
    const response = await get('/api/gsc/status', admin);
    expect(response.status).toBe(200);
    const body = await response.json<{ properties: { property: string; mapped: boolean }[]; mapping: { mapped: number; unmapped: string[] }; configured: boolean; sync: { last_success_at: string | null } }>();
    expect(body.properties).toHaveLength(GSC_PROPERTIES.length);
    expect(body.mapping.mapped).toBe(1);
    expect(body.mapping.unmapped).toHaveLength(GSC_PROPERTIES.length - 1);
    expect(body.mapping.unmapped).toEqual(expect.arrayContaining([
      'sc-domain:roadnaturalist.com', 'sc-domain:hankmarquardt.com',
    ]));
    expect(body.configured).toBe(false);
    expect(body.sync.last_success_at).toBeNull();
  });
});
