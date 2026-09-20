import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { ApiError, readLimited } from '../http';
import { requireHumanAdmin } from '../auth/human';
import { hashToken } from '../auth/crypto';

// Public analytics collector plus admin dashboard queries. The collector path and
// request contract intentionally match the legacy LabBox API so existing pages need
// no edits after the hostname cutover.
export const ANALYTICS_SITES: Record<string, { name: string; origins: string[] }> = {
  'junkdrawer': { name: "Hank's Junk Drawer", origins: ['https://hmarquardt.github.io'] },
  'top-hat-ferals': { name: 'Top Hat Ferals', origins: ['https://tophatferals.com', 'https://www.tophatferals.com', 'https://hmarquardt.github.io'] },
};
const ALLOWED_ORIGINS = new Set(Object.values(ANALYTICS_SITES).flatMap(site => site.origins));
const MAX_BODY_BYTES = 32 * 1024;
const EVENT_TYPES = new Set(['pageview', 'heartbeat', 'event']);

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}
function optionalString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  return cleanString(value, max);
}
function optionalNumber(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}
function parseUserAgent(userAgent: string | null): { browser: string | null; os: string | null; device: string | null } {
  if (!userAgent) return { browser: null, os: null, device: null };
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Other';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(userAgent) ? 'tablet' : /Mobi|Android|iPhone/.test(userAgent) ? 'mobile' : 'desktop';
  return { browser, os, device };
}
function isBot(userAgent: string | null): boolean {
  return !!userAgent && /bot|crawler|spider|preview|headless/i.test(userAgent);
}
function dayBounds(from: string, to: string): { start: string; end: string } {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) throw new ApiError(400, 'invalid_input', 'Invalid date range');
  return { start: `${from}T00:00:00.000Z`, end: `${to}T23:59:59.999Z` };
}

export const analytics = new Hono<ContextEnv>();
analytics.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin !== undefined && (origin === new URL(c.req.url).origin || ALLOWED_ORIGINS.has(origin));
  if (origin && !allowed) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin!);
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Methods', 'GET, POST');
    c.header('Access-Control-Allow-Headers', 'authorization, content-type');
    c.header('Access-Control-Max-Age', '300');
    return c.body(null, 204);
  }
  await next();
  if (allowed) c.header('Access-Control-Allow-Origin', origin!);
});

analytics.post('/collect', async c => {
  const contentLength = Number(c.req.header('Content-Length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large', 'Request too large');
  const bytes = await readLimited(c.req.raw.body, MAX_BODY_BYTES);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    payload = parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_event', 'Invalid analytics event'); }

  const siteId = cleanString(payload.site_id, 64);
  const site = siteId ? ANALYTICS_SITES[siteId] : undefined;
  if (!site) throw new ApiError(404, 'unknown_site', 'Unknown site');
  const origin = c.req.header('Origin');
  if (origin && !site.origins.includes(origin) && origin !== new URL(c.req.url).origin) throw new ApiError(400, 'invalid_event', 'Invalid analytics event');

  const eventType = cleanString(payload.event_type, 32);
  const visitorId = cleanString(payload.visitor_id, 128);
  const sessionId = cleanString(payload.session_id, 128);
  const occurredAt = cleanString(payload.occurred_at, 64);
  const page = (payload.page && typeof payload.page === 'object' && !Array.isArray(payload.page)) ? payload.page as Record<string, unknown> : {};
  const pageUrl = cleanString(page.url, 2048);
  const pagePath = cleanString(page.path, 1024);
  if (!eventType || !EVENT_TYPES.has(eventType) || !visitorId || !sessionId || !occurredAt || !pageUrl || !pagePath
      || Number.isNaN(Date.parse(occurredAt))) {
    throw new ApiError(400, 'invalid_event', 'Invalid analytics event');
  }
  const referrer = (payload.referrer && typeof payload.referrer === 'object' && !Array.isArray(payload.referrer)) ? payload.referrer as Record<string, unknown> : {};
  const utm = (payload.utm && typeof payload.utm === 'object' && !Array.isArray(payload.utm)) ? payload.utm as Record<string, unknown> : {};
  const client = (payload.client && typeof payload.client === 'object' && !Array.isArray(payload.client)) ? payload.client as Record<string, unknown> : {};
  const performance = (payload.performance && typeof payload.performance === 'object' && !Array.isArray(payload.performance)) ? payload.performance as Record<string, unknown> : {};
  const userAgent = optionalString(client.user_agent, 512);
  const parsedAgent = parseUserAgent(userAgent);
  const bot = isBot(userAgent);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rateKey = `${siteId}:${await hashToken(ip)}`;
  if (c.env.RL_ANALYTICS) {
    const { success } = await c.env.RL_ANALYTICS.limit({ key: rateKey });
    if (!success) throw new ApiError(429, 'rate_limited', 'Too many requests');
  }
  const db = c.env.ANALYTICS;
  const now = new Date().toISOString();
  const referrerUrl = optionalString(referrer.url, 2048);
  const referrerDomain = optionalString(referrer.domain, 256);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO visitors (id, site_id, first_seen_at, last_seen_at, first_path, last_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_path = excluded.last_path`)
      .bind(visitorId, siteId, occurredAt, occurredAt, pagePath, pagePath),
    db.prepare(`INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, landing_path, exit_path, referrer_url, referrer_domain, utm_source, utm_medium, utm_campaign, pageview_count, heartbeat_count, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, exit_path = excluded.exit_path,
        pageview_count = sessions.pageview_count + excluded.pageview_count,
        heartbeat_count = sessions.heartbeat_count + excluded.heartbeat_count,
        duration_seconds = COALESCE(excluded.duration_seconds, sessions.duration_seconds)`)
      .bind(sessionId, siteId, visitorId, occurredAt, occurredAt, pagePath, pagePath, referrerUrl, referrerDomain,
        optionalString(utm.source, 256), optionalString(utm.medium, 256), optionalString(utm.campaign, 256),
        eventType === 'pageview' ? 1 : 0, eventType === 'heartbeat' ? 1 : 0,
        optionalNumber(payload.duration_seconds, 0, 86_400)),
  ];
  if (eventType === 'pageview') {
    statements.push(db.prepare(`INSERT INTO pageviews (id, site_id, visitor_id, session_id, occurred_at, received_at, page_url, page_host, page_path, page_query, page_title,
      referrer_url, referrer_domain, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      browser_name, os_name, device_type, language, timezone, screen_width, screen_height, viewport_width, viewport_height,
      load_time_ms, navigation_type, is_bot, bot_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), siteId, visitorId, sessionId, occurredAt, now, pageUrl,
        optionalString(page.host, 256), pagePath, optionalString(page.query, 1024), optionalString(page.title, 512),
        referrerUrl, referrerDomain, optionalString(utm.source, 256), optionalString(utm.medium, 256), optionalString(utm.campaign, 256),
        optionalString(utm.term, 256), optionalString(utm.content, 256),
        parsedAgent.browser, parsedAgent.os, parsedAgent.device,
        optionalString(client.language, 64), optionalString(client.timezone, 128),
        optionalNumber(client.screen_width, 0, 100_000), optionalNumber(client.screen_height, 0, 100_000),
        optionalNumber(client.viewport_width, 0, 100_000), optionalNumber(client.viewport_height, 0, 100_000),
        optionalNumber(performance.load_time_ms, 0, 3_600_000), optionalString(performance.navigation_type, 32),
        bot ? 1 : 0, bot ? 'user_agent' : null));
  }
  if (eventType === 'event') {
    let propsJson: string | null = null;
    if (payload.props !== undefined) {
      try {
        const serialized = JSON.stringify(payload.props);
        if (serialized.length <= 4096) propsJson = serialized;
      } catch { propsJson = null; }
    }
    const targetUrl = optionalString(payload.target_url, 2048);
    statements.push(db.prepare(`INSERT INTO events (id, site_id, visitor_id, session_id, event_type, occurred_at, received_at,
      page_url, page_path, event_name, target_url, target_domain, value_number, value_text, props_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), siteId, visitorId, sessionId, optionalString(payload.event_name, 128) ?? 'event', occurredAt, now,
        pageUrl, pagePath, optionalString(payload.event_name, 128), targetUrl,
        targetDomain(targetUrl),
        optionalNumber(payload.value_number, -1e12, 1e12), optionalString(payload.value_text, 1024), propsJson));
  }
  await db.batch(statements);
  return c.json({ ok: true });
});

analytics.get('/summary', requireHumanAdmin, async c => {
  const siteId = siteParam(c.req.query('site_id'));
  const { start, end } = dayBounds(c.req.query('from') ?? '', c.req.query('to') ?? '');
  const row = await c.env.ANALYTICS.prepare(
    `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
     FROM pageviews WHERE site_id = ? AND occurred_at BETWEEN ? AND ? AND is_bot = 0`).bind(siteId, start, end)
    .first<{ pageviews: number; visitors: number; sessions: number }>();
  const bounce = await c.env.ANALYTICS.prepare(
    `SELECT AVG(CASE WHEN pageview_count <= 1 THEN 1.0 ELSE 0.0 END) AS bounce_rate FROM sessions WHERE site_id = ? AND started_at BETWEEN ? AND ?`)
    .bind(siteId, start, end).first<{ bounce_rate: number | null }>();
  const pageviews = Number(row?.pageviews ?? 0);
  const sessions = Number(row?.sessions ?? 0);
  return c.json({ site_id: siteId, from: c.req.query('from'), to: c.req.query('to'), pageviews,
    visitors: Number(row?.visitors ?? 0), sessions,
    avg_pageviews_per_session: sessions ? Math.round((pageviews / sessions) * 100) / 100 : 0,
    bounce_rate: Math.round(Number(bounce?.bounce_rate ?? 0) * 100) / 100 });
});
analytics.get('/timeseries', requireHumanAdmin, async c => {
  const siteId = siteParam(c.req.query('site_id'));
  const { start, end } = dayBounds(c.req.query('from') ?? '', c.req.query('to') ?? '');
  const bucket = c.req.query('bucket') ?? 'day';
  if (bucket !== 'day' && bucket !== 'hour') throw new ApiError(400, 'invalid_input', 'Invalid bucket');
  const expression = bucket === 'hour' ? "strftime('%Y-%m-%dT%H:00:00Z', occurred_at)" : 'date(occurred_at)';
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT ${expression} AS bucket_date, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
     FROM pageviews WHERE site_id = ? AND occurred_at BETWEEN ? AND ? AND is_bot = 0 GROUP BY bucket_date ORDER BY bucket_date`)
    .bind(siteId, start, end).all<{ bucket_date: string; pageviews: number; visitors: number; sessions: number }>();
  return c.json({ bucket, points: results });
});
analytics.get('/pages', requireHumanAdmin, async c => {
  const siteId = siteParam(c.req.query('site_id'));
  const { start, end } = dayBounds(c.req.query('from') ?? '', c.req.query('to') ?? '');
  const limit = limitParam(c.req.query('limit'));
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT pv.page_path, MAX(pv.page_title) AS page_title, COUNT(*) AS pageviews, COUNT(DISTINCT pv.visitor_id) AS visitors,
       COUNT(DISTINCT pv.session_id) AS sessions, AVG(CASE WHEN s.pageview_count <= 1 THEN 1.0 ELSE 0.0 END) AS bounce_rate
     FROM pageviews pv LEFT JOIN sessions s ON s.id = pv.session_id
     WHERE pv.site_id = ? AND pv.occurred_at BETWEEN ? AND ? AND pv.is_bot = 0
     GROUP BY pv.page_path ORDER BY pageviews DESC, pv.page_path LIMIT ?`)
    .bind(siteId, start, end, limit).all<{ page_path: string; page_title: string | null; pageviews: number; visitors: number; sessions: number; bounce_rate: number | null }>();
  return c.json({ pages: results.map(row => ({ path: row.page_path, title: row.page_title, pageviews: row.pageviews,
    visitors: row.visitors, sessions: row.sessions, bounce_rate: Math.round(Number(row.bounce_rate ?? 0) * 100) / 100 })) });
});
analytics.get('/referrers', requireHumanAdmin, async c => {
  const siteId = siteParam(c.req.query('site_id'));
  const { start, end } = dayBounds(c.req.query('from') ?? '', c.req.query('to') ?? '');
  const limit = limitParam(c.req.query('limit'));
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT COALESCE(NULLIF(referrer_domain, ''), 'direct') AS domain, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
     FROM pageviews WHERE site_id = ? AND occurred_at BETWEEN ? AND ? AND is_bot = 0
     GROUP BY domain ORDER BY pageviews DESC, domain LIMIT ?`)
    .bind(siteId, start, end, limit).all<{ domain: string; pageviews: number; visitors: number }>();
  return c.json({ referrers: results });
});
analytics.get('/recent', requireHumanAdmin, async c => {
  const siteId = siteParam(c.req.query('site_id'));
  const limit = limitParam(c.req.query('limit'));
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT occurred_at, page_path, page_title, referrer_domain, browser_name, os_name, device_type, is_bot
     FROM pageviews WHERE site_id = ? ORDER BY occurred_at DESC, received_at DESC LIMIT ?`)
    .bind(siteId, limit).all<Record<string, unknown>>();
  return c.json({ visits: results.map(row => ({ ...row, is_bot: !!row.is_bot })) });
});
function targetDomain(targetUrl: string | null): string | null {
  if (!targetUrl) return null;
  try { return new URL(targetUrl).hostname.replace(/^www\./i, ''); } catch { return null; }
}
function siteParam(value: string | undefined): string {
  if (!value || !ANALYTICS_SITES[value]) throw new ApiError(404, 'unknown_site', 'Unknown site');
  return value;
}
function limitParam(value: string | undefined): number {
  const parsed = Number(value ?? '50');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) throw new ApiError(400, 'invalid_input', 'Invalid limit');
  return parsed;
}

