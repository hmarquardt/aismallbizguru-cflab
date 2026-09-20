import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AnalyticsEnv } from './env';
import { ApiError } from '../http';
import { normalizeHostname, shiftDay, siteDay, validDay } from './sanitize';
import type { SiteRow } from './sites';

export const reporting = new Hono<AnalyticsEnv>();

interface Filters {
  from: string;
  to: string;
  domainId: number | null;
  domainHost: string | null;
}

async function filters(c: Context<AnalyticsEnv>): Promise<Filters> {
  const site = c.get('site');
  const today = siteDay(site.timezone, Date.now());
  const to = c.req.query('to') ?? today;
  const from = c.req.query('from') ?? shiftDay(to, -6);
  if (!validDay(from) || !validDay(to) || from > to) throw new ApiError(400, 'invalid_input', 'Invalid date range');
  let domainId: number | null = null;
  let domainHost: string | null = null;
  const rawDomain = c.req.query('domain');
  if (rawDomain) {
    const host = normalizeHostname(rawDomain);
    if (!host) throw new ApiError(400, 'invalid_input', 'Invalid domain');
    const row = await c.env.ANALYTICS.prepare('SELECT id, hostname FROM analytics_domains WHERE site_id = ? AND hostname = ?')
      .bind(site.id, host).first<{ id: number; hostname: string }>();
    if (!row) throw new ApiError(400, 'invalid_input', 'Unknown domain');
    domainId = row.id;
    domainHost = row.hostname;
  }
  return { from, to, domainId, domainHost };
}

function limitParam(value: string | undefined, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) throw new ApiError(400, 'invalid_input', 'Invalid limit');
  return parsed;
}

function where(f: Filters, siteId: number): { sql: string; params: (string | number)[] } {
  let sql = 'site_id = ? AND site_day >= ? AND site_day <= ?';
  const params: (string | number)[] = [siteId, f.from, f.to];
  if (f.domainId !== null) {
    sql += ' AND domain_id = ?';
    params.push(f.domainId);
  }
  return { sql, params };
}

function rawWindow(f: Filters, site: SiteRow, today: string): Filters {
  const cutoff = shiftDay(today, -site.raw_retention_days);
  return { ...f, from: f.from > cutoff ? f.from : cutoff };
}

interface Totals {
  pageviews: number;
  events: number;
  sessions: number;
}

function emptyTotals(): Totals {
  return { pageviews: 0, events: 0, sessions: 0 };
}

function addTotals(target: Totals, row: Partial<Totals> | null | undefined): void {
  target.pageviews += Number(row?.pageviews ?? 0);
  target.events += Number(row?.events ?? 0);
  target.sessions += Number(row?.sessions ?? 0);
}

// Daily aggregate fallback: raw rows are purged after raw_retention_days, so
// longer ranges combine retained raw events with rollup totals.
async function aggregateTotals(db: D1Database, f: Filters, site: SiteRow, today: string): Promise<Totals> {
  const cutoff = shiftDay(today, -site.raw_retention_days);
  const totals = emptyTotals();
  if (f.from >= cutoff) return totals;
  const aggTo = f.to < cutoff ? f.to : shiftDay(cutoff, -1);
  if (f.domainId !== null) {
    const row = await db.prepare('SELECT COALESCE(SUM(pageviews),0) AS pageviews, COALESCE(SUM(events),0) AS events, COALESCE(SUM(sessions),0) AS sessions FROM analytics_daily_domains WHERE site_id = ? AND site_day >= ? AND site_day <= ? AND domain_id = ?')
      .bind(site.id, f.from, aggTo, f.domainId).first<Totals>();
    addTotals(totals, row);
  } else {
    const row = await db.prepare('SELECT COALESCE(SUM(pageviews),0) AS pageviews, COALESCE(SUM(events),0) AS events, COALESCE(SUM(sessions),0) AS sessions FROM analytics_daily_site WHERE site_id = ? AND site_day >= ? AND site_day <= ?')
      .bind(site.id, f.from, aggTo).first<Totals>();
    addTotals(totals, row);
  }
  return totals;
}

reporting.get('/summary', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const today = siteDay(site.timezone, Date.now());
  const totals = emptyTotals();
  const raw = rawWindow(f, site, today);
  if (raw.from <= raw.to) {
    const w = where(raw, site.id);
    const row = await c.env.ANALYTICS.prepare(
      `SELECT COALESCE(SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END), 0) AS pageviews,
              COALESCE(SUM(CASE WHEN event_kind = 'event' THEN 1 ELSE 0 END), 0) AS events,
              COUNT(DISTINCT session_id) AS sessions
       FROM analytics_events WHERE ${w.sql}`).bind(...w.params).first<Totals>();
    addTotals(totals, row);
  }
  addTotals(totals, await aggregateTotals(c.env.ANALYTICS, f, site, today));

  let bounceRate = 0;
  if (raw.from <= raw.to) {
    const w = where(raw, site.id);
    const bounce = await c.env.ANALYTICS.prepare(
      `SELECT AVG(CASE WHEN n <= 1 THEN 1.0 ELSE 0.0 END) AS bounce_rate FROM (
         SELECT session_id, COUNT(*) AS n FROM analytics_events
         WHERE ${w.sql} AND event_kind = 'pageview' AND session_id IS NOT NULL
         GROUP BY session_id)`).bind(...w.params).first<{ bounce_rate: number | null }>();
    bounceRate = Number(bounce?.bounce_rate ?? 0);
  }
  return c.json({
    site: site.public_id,
    from: f.from,
    to: f.to,
    domain: f.domainHost,
    pageviews: totals.pageviews,
    events: totals.events,
    sessions: totals.sessions,
    pages_per_session: totals.sessions ? Math.round((totals.pageviews / totals.sessions) * 100) / 100 : 0,
    bounce_rate: Math.round(bounceRate * 100) / 100,
  });
});

reporting.get('/timeseries', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const bucket = c.req.query('bucket') ?? 'day';
  if (bucket !== 'day' && bucket !== 'hour') throw new ApiError(400, 'invalid_input', 'Invalid bucket');
  const today = siteDay(site.timezone, Date.now());
  const points = new Map<string, Totals>();
  const merge = (date: string, row: Partial<Totals>) => {
    const current = points.get(date) ?? emptyTotals();
    addTotals(current, row);
    points.set(date, current);
  };
  const raw = rawWindow(f, site, today);
  if (raw.from <= raw.to) {
    const w = where(raw, site.id);
    const expression = bucket === 'hour'
      ? "strftime('%Y-%m-%dT%H:00:00Z', received_at_ms / 1000, 'unixepoch')"
      : 'site_day';
    const { results } = await c.env.ANALYTICS.prepare(
      `SELECT ${expression} AS bucket_date,
              COALESCE(SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END), 0) AS pageviews,
              COALESCE(SUM(CASE WHEN event_kind = 'event' THEN 1 ELSE 0 END), 0) AS events,
              COUNT(DISTINCT session_id) AS sessions
       FROM analytics_events WHERE ${w.sql} GROUP BY bucket_date ORDER BY bucket_date`).bind(...w.params).all<{ bucket_date: string } & Totals>();
    for (const row of results) merge(row.bucket_date, row);
  }
  if (bucket === 'day') {
    const cutoff = shiftDay(today, -site.raw_retention_days);
    if (f.from < cutoff) {
      const aggTo = f.to < cutoff ? f.to : shiftDay(cutoff, -1);
      const domainClause = f.domainId !== null ? ' AND domain_id = ?' : '';
      const params: (string | number)[] = f.domainId !== null ? [site.id, f.from, aggTo, f.domainId] : [site.id, f.from, aggTo];
      const table = f.domainId !== null ? 'analytics_daily_domains' : 'analytics_daily_site';
      const { results } = await c.env.ANALYTICS.prepare(
        `SELECT site_day AS bucket_date, pageviews, events, sessions FROM ${table}
         WHERE site_id = ? AND site_day >= ? AND site_day <= ?${domainClause} ORDER BY site_day`)
        .bind(...params).all<{ bucket_date: string } & Totals>();
      for (const row of results) merge(row.bucket_date, row);
    }
  }
  return c.json({
    site: site.public_id, bucket, from: f.from, to: f.to, domain: f.domainHost,
    points: [...points.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, ...totals })),
  });
});

reporting.get('/pages', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT pathname, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${w.sql} AND event_kind = 'pageview'
     GROUP BY pathname ORDER BY pageviews DESC, pathname LIMIT ?`).bind(...w.params, limit)
    .all<{ pathname: string; pageviews: number; sessions: number }>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, pages: results });
});

reporting.get('/referrers', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT COALESCE(referrer_host, 'direct') AS referrer, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${w.sql} AND event_kind = 'pageview'
     GROUP BY referrer ORDER BY pageviews DESC, referrer LIMIT ?`).bind(...w.params, limit)
    .all<{ referrer: string; pageviews: number; sessions: number }>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, referrers: results });
});

reporting.get('/campaigns', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, COALESCE(utm_campaign, '') AS campaign,
            COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${w.sql} AND event_kind = 'pageview'
       AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
     GROUP BY source, medium, campaign ORDER BY pageviews DESC LIMIT ?`).bind(...w.params, limit)
    .all<{ source: string; medium: string; campaign: string; pageviews: number; sessions: number }>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, campaigns: results });
});

reporting.get('/devices', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'), 20);
  const w = where(f, site.id);
  const dimension = async (column: 'device' | 'browser' | 'os') => {
    const { results } = await c.env.ANALYTICS.prepare(
      `SELECT COALESCE(${column}, 'unknown') AS value, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
       FROM analytics_events WHERE ${w.sql} AND event_kind = 'pageview'
       GROUP BY value ORDER BY pageviews DESC, value LIMIT ?`).bind(...w.params, limit)
      .all<{ value: string; pageviews: number; sessions: number }>();
    return results;
  };
  return c.json({
    site: site.public_id, from: f.from, to: f.to, domain: f.domainHost,
    devices: await dimension('device'), browsers: await dimension('browser'), operating_systems: await dimension('os'),
  });
});

reporting.get('/geography', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT COALESCE(country_code, 'unknown') AS country, COALESCE(region_code, '') AS region,
            COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${w.sql} AND event_kind = 'pageview'
     GROUP BY country, region ORDER BY pageviews DESC LIMIT ?`).bind(...w.params, limit)
    .all<{ country: string; region: string; pageviews: number; sessions: number }>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, geography: results });
});

reporting.get('/events', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT event_name, COUNT(*) AS count, COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${w.sql} AND event_kind = 'event'
     GROUP BY event_name ORDER BY count DESC, event_name LIMIT ?`).bind(...w.params, limit)
    .all<{ event_name: string; count: number; sessions: number }>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, events: results });
});

reporting.get('/recent', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const limit = limitParam(c.req.query('limit'));
  const w = where(f, site.id);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT received_at_ms, event_kind, event_name, pathname, referrer_host, browser, os, device, country_code
     FROM analytics_events WHERE ${w.sql} ORDER BY received_at_ms DESC, id DESC LIMIT ?`).bind(...w.params, limit)
    .all<Record<string, unknown>>();
  return c.json({ site: site.public_id, from: f.from, to: f.to, domain: f.domainHost, events: results });
});

reporting.get('/live', async c => {
  const site = c.get('site');
  const f = await filters(c);
  const cutoff = Date.now() - 5 * 60 * 1000;
  let sql = 'site_id = ? AND received_at_ms >= ?';
  const params: (string | number)[] = [site.id, cutoff];
  if (f.domainId !== null) {
    sql += ' AND domain_id = ?';
    params.push(f.domainId);
  }
  const totals = await c.env.ANALYTICS.prepare(
    `SELECT COUNT(*) AS events, COALESCE(SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END), 0) AS pageviews,
            COUNT(DISTINCT session_id) AS sessions
     FROM analytics_events WHERE ${sql}`).bind(...params).first<Totals>();
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT pathname, COUNT(*) AS events FROM analytics_events WHERE ${sql}
     GROUP BY pathname ORDER BY events DESC, pathname LIMIT 10`).bind(...params)
    .all<{ pathname: string; events: number }>();
  return c.json({
    site: site.public_id, window_seconds: 300,
    events: Number(totals?.events ?? 0),
    pageviews: Number(totals?.pageviews ?? 0),
    sessions: Number(totals?.sessions ?? 0),
    pages: results,
  });
});
