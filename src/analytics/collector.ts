import { Hono } from 'hono';
import type { AnalyticsEnv } from './env';
import { ApiError, readLimited } from '../http';
import { hashToken } from '../shared/crypto';
import { findActiveDomain, findSiteForCollection, type DomainRow, type SiteRow } from './sites';
import * as s from './sanitize';

const LEGACY_EVENT_TYPES = new Set(['pageview', 'heartbeat', 'event', 'custom']);

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJson(request: Request, max: number, allowMissingType: boolean): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType ? contentType !== 'application/json' : !allowMissingType) {
    throw new ApiError(415, 'unsupported_media_type', 'Expected application/json');
  }
  if (Number(request.headers.get('content-length') ?? '0') > max) throw new ApiError(413, 'body_too_large', 'Request too large');
  const bytes = await readLimited(request.body, max);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_event', 'Invalid analytics event');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_event', 'Invalid analytics event');
  return value as Record<string, unknown>;
}

function suppressed(site: SiteRow, request: Request): boolean {
  if (site.respect_dnt && request.headers.get('DNT') === '1') return true;
  if (site.respect_gpc && request.headers.get('Sec-GPC') === '1') return true;
  return false;
}

async function enforceRateLimit(env: AnalyticsEnv['Bindings'], site: SiteRow, ip: string | null): Promise<void> {
  if (!env.RL_ANALYTICS) return;
  // The IP is only ever used transiently as a rate-limit key input; it is
  // never written to analytics storage.
  const key = `${site.id}:${await hashToken(ip ?? 'unknown')}`;
  const { success } = await env.RL_ANALYTICS.limit({ key });
  if (!success) throw new ApiError(429, 'rate_limited', 'Too many requests');
}

async function ensureEventName(db: D1Database, siteId: number, name: string): Promise<void> {
  const existing = await db.prepare('SELECT 1 FROM analytics_event_names WHERE site_id = ? AND event_name = ?')
    .bind(siteId, name).first();
  if (existing) return;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM analytics_event_names WHERE site_id = ?')
    .bind(siteId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= s.MAX_EVENT_NAMES_PER_SITE) {
    throw new ApiError(400, 'event_name_limit', 'Event name limit reached');
  }
  await db.prepare('INSERT OR IGNORE INTO analytics_event_names (site_id, event_name, created_at_ms) VALUES (?, ?, ?)')
    .bind(siteId, name, Date.now()).run();
}

interface EventInput {
  eventUid: string;
  site: SiteRow;
  domain: DomainRow;
  kind: 'pageview' | 'event';
  name: string;
  sessionId: string | null;
  pathname: string;
  referrerHost: string | null;
  utm: Record<string, unknown>;
  agent: s.ParsedAgent;
  country: string | null;
  region: string | null;
  propsJson: string | null;
}

async function insertEvent(db: D1Database, input: EventInput): Promise<boolean> {
  const nowMs = Date.now();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO analytics_events
      (event_uid, site_id, domain_id, received_at_ms, site_day, event_kind, event_name, session_id, pathname,
       referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       browser, os, device, country_code, region_code, props_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.eventUid, input.site.id, input.domain.id, nowMs, s.siteDay(input.site.timezone, nowMs),
    input.kind, input.name, input.sessionId, input.pathname,
    input.referrerHost, s.optionalText(input.utm.source, 200), s.optionalText(input.utm.medium, 200),
    s.optionalText(input.utm.campaign, 200), s.optionalText(input.utm.content, 200), s.optionalText(input.utm.term, 200),
    input.agent.browser, input.agent.os, input.agent.device, input.country, input.region, input.propsJson,
  ).run();
  return result.meta.changes > 0;
}

export const collector = new Hono<AnalyticsEnv>();

// Canonical first-party collector. Session IDs are anonymous and client
// generated; there is no persistent visitor identifier.
collector.post('/collect', async c => {
  const body = await readJson(c.req.raw, s.MAX_CANONICAL_BODY_BYTES, false);
  const siteRef = s.cleanText(body.site, 64);
  const site = siteRef ? await findSiteForCollection(c.env.ANALYTICS, siteRef) : null;
  if (!site || !site.active) return c.body(null, 204);
  if (suppressed(site, c.req.raw)) return c.body(null, 204);

  const hostname = s.requestHostname(c.req.raw);
  if (!hostname) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  const domain = await findActiveDomain(c.env.ANALYTICS, site.id, hostname);
  if (!domain) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');

  const userAgent = c.req.header('User-Agent') ?? null;
  if (s.isBot(userAgent)) return c.body(null, 204);
  await enforceRateLimit(c.env, site, c.req.header('CF-Connecting-IP') ?? null);

  const kind = s.cleanText(body.kind, 16);
  if (kind !== 'pageview' && kind !== 'event') throw new ApiError(400, 'invalid_event', 'Invalid analytics event');
  let name = 'pageview';
  let propsJson: string | null = null;
  if (kind === 'event') {
    const validName = s.validEventName(body.name);
    if (!validName) throw new ApiError(400, 'invalid_event_name', 'Invalid event name');
    const props = s.sanitizeProps(body.props);
    if (!props.ok) throw new ApiError(400, 'invalid_props', 'Invalid event properties');
    await ensureEventName(c.env.ANALYTICS, site.id, validName);
    name = validName;
    propsJson = props.json;
  }

  await insertEvent(c.env.ANALYTICS, {
    eventUid: s.validEventUid(body.event_uid) ?? crypto.randomUUID(),
    site, domain, kind, name,
    sessionId: s.validSessionId(body.session),
    pathname: s.normalizePathname(body.path) ?? '/',
    referrerHost: s.referrerHost(body.referrer),
    utm: objectOrEmpty(body.utm),
    agent: s.parseUserAgent(userAgent),
    country: s.countryCode(c.req.header('CF-IPCountry') ?? null),
    region: s.regionCode(c.req.header('CF-Region-Code') ?? null),
    propsJson,
  });
  return c.body(null, 204);
});

// Legacy collector contract served at the deployed snippet path. It writes the
// new model and dual-writes the legacy tables so the existing dashboard keeps
// receiving fresh data until it is retired. The raw User-Agent is never stored.
collector.post('/api/analytics/collect', async c => {
  const body = await readJson(c.req.raw, s.MAX_LEGACY_BODY_BYTES, true);
  const siteId = s.cleanText(body.site_id, 64);
  const site = siteId ? await findSiteForCollection(c.env.ANALYTICS, siteId) : null;
  if (!site || !site.active) return c.body(null, 204);
  if (suppressed(site, c.req.raw)) return c.body(null, 204);

  const page = objectOrEmpty(body.page);
  // Source attribution is instrumentation integrity, not authentication:
  // Origin and Referer are spoofable by arbitrary HTTP clients. Use the first
  // well-formed source (Origin, then the payload's document host, then
  // Referer) and require it to be an active domain of this Site. A request
  // with no usable source succeeds without recording; a present but
  // unregistered source is rejected. Never default to the primary domain.
  const sourceHost = s.requestHostname(c.req.raw)
    ?? s.normalizeHostname(page.host)
    ?? s.normalizeHostname(c.req.header('Referer') ?? null);
  if (!sourceHost) return c.json({ ok: true });
  const domain: DomainRow | null = await findActiveDomain(c.env.ANALYTICS, site.id, sourceHost);
  if (!domain) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');

  const eventType = s.cleanText(body.event_type, 32);
  const visitorId = s.cleanText(body.visitor_id, 128);
  const sessionId = s.cleanText(body.session_id, 128);
  const occurredAt = s.cleanText(body.occurred_at, 64);
  const pageUrl = s.cleanText(page.url, 2048);
  const pagePath = s.cleanText(page.path, 1024);
  if (!eventType || !LEGACY_EVENT_TYPES.has(eventType) || !visitorId || !sessionId || !occurredAt || !pageUrl || !pagePath
      || Number.isNaN(Date.parse(occurredAt))) {
    throw new ApiError(400, 'invalid_event', 'Invalid analytics event');
  }
  const client = objectOrEmpty(body.client);
  const userAgent = s.optionalText(client.user_agent, 512) ?? c.req.header('User-Agent') ?? null;
  if (s.isBot(userAgent)) return c.body(null, 204);
  await enforceRateLimit(c.env, site, c.req.header('CF-Connecting-IP') ?? null);

  const kind: 'pageview' | 'event' = eventType === 'pageview' ? 'pageview' : 'event';
  let name = 'pageview';
  if (kind === 'event') {
    name = eventType === 'heartbeat' ? 'heartbeat' : (s.validEventName(body.event_name) ?? 'event');
    await ensureEventName(c.env.ANALYTICS, site.id, name);
  }
  const props = s.sanitizeProps(body.props);
  const utm = objectOrEmpty(body.utm);
  const referrer = objectOrEmpty(body.referrer);

  const inserted = await insertEvent(c.env.ANALYTICS, {
    eventUid: crypto.randomUUID(),
    site, domain, kind, name,
    sessionId: s.validSessionId(sessionId),
    pathname: s.normalizePathname(pagePath) ?? '/',
    referrerHost: s.referrerHost(referrer.url) ?? s.normalizeHostname(referrer.domain),
    utm,
    agent: s.parseUserAgent(userAgent),
    country: s.countryCode(c.req.header('CF-IPCountry') ?? null),
    region: s.regionCode(c.req.header('CF-Region-Code') ?? null),
    propsJson: kind === 'event' && props.ok ? props.json : null,
  });
  if (inserted) {
    await writeLegacy(c.env.ANALYTICS, {
      site, eventType, visitorId, sessionId, occurredAt, page, pageUrl, pagePath,
      referrer, utm, client, performance: objectOrEmpty(body.performance), props: body.props,
      targetUrl: s.optionalText(body.target_url, 2048),
      valueNumber: s.optionalNumber(body.value_number, -1e12, 1e12),
      valueText: s.optionalText(body.value_text, 1024),
      eventName: s.optionalText(body.event_name, 128),
      durationSeconds: s.optionalNumber(body.duration_seconds, 0, 86_400),
    });
  }
  return c.json({ ok: true });
});

interface LegacyWrite {
  site: SiteRow;
  eventType: string;
  visitorId: string;
  sessionId: string;
  occurredAt: string;
  page: Record<string, unknown>;
  pageUrl: string;
  pagePath: string;
  referrer: Record<string, unknown>;
  utm: Record<string, unknown>;
  client: Record<string, unknown>;
  performance: Record<string, unknown>;
  props: unknown;
  targetUrl: string | null;
  valueNumber: number | null;
  valueText: string | null;
  eventName: string | null;
  durationSeconds: number | null;
}

// Temporary compatibility bridge: the legacy dashboard reads these tables.
// Remove together with CFLab's legacy reporting routes once the new dashboard
// is proven in production.
async function writeLegacy(db: D1Database, input: LegacyWrite): Promise<void> {
  const siteKey = input.site.legacy_key ?? String(input.site.id);
  const now = new Date().toISOString();
  const referrerUrl = s.optionalText(input.referrer.url, 2048);
  const referrerDomain = s.optionalText(input.referrer.domain, 256);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO visitors (id, site_id, first_seen_at, last_seen_at, first_path, last_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_path = excluded.last_path`)
      .bind(input.visitorId, siteKey, input.occurredAt, input.occurredAt, input.pagePath, input.pagePath),
    db.prepare(`INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, landing_path, exit_path, referrer_url, referrer_domain, utm_source, utm_medium, utm_campaign, pageview_count, heartbeat_count, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, exit_path = excluded.exit_path,
        pageview_count = sessions.pageview_count + excluded.pageview_count,
        heartbeat_count = sessions.heartbeat_count + excluded.heartbeat_count,
        duration_seconds = COALESCE(excluded.duration_seconds, sessions.duration_seconds)`)
      .bind(input.sessionId, siteKey, input.visitorId, input.occurredAt, input.occurredAt, input.pagePath, input.pagePath,
        referrerUrl, referrerDomain, s.optionalText(input.utm.source, 256), s.optionalText(input.utm.medium, 256),
        s.optionalText(input.utm.campaign, 256), input.eventType === 'pageview' ? 1 : 0,
        input.eventType === 'heartbeat' ? 1 : 0, input.durationSeconds),
  ];
  if (input.eventType === 'pageview') {
    const agent = s.parseUserAgent(s.optionalText(input.client.user_agent, 512));
    statements.push(db.prepare(`INSERT INTO pageviews (id, site_id, visitor_id, session_id, occurred_at, received_at, page_url, page_host, page_path, page_query, page_title,
      referrer_url, referrer_domain, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      browser_name, os_name, device_type, language, timezone, screen_width, screen_height, viewport_width, viewport_height,
      load_time_ms, navigation_type, is_bot, bot_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), siteKey, input.visitorId, input.sessionId, input.occurredAt, now, input.pageUrl,
        s.optionalText(input.page.host, 256), input.pagePath, s.optionalText(input.page.query, 1024), s.optionalText(input.page.title, 512),
        referrerUrl, referrerDomain, s.optionalText(input.utm.source, 256), s.optionalText(input.utm.medium, 256),
        s.optionalText(input.utm.campaign, 256), s.optionalText(input.utm.term, 256), s.optionalText(input.utm.content, 256),
        agent.browser, agent.os, agent.device,
        s.optionalText(input.client.language, 64), s.optionalText(input.client.timezone, 128),
        s.optionalNumber(input.client.screen_width, 0, 100_000), s.optionalNumber(input.client.screen_height, 0, 100_000),
        s.optionalNumber(input.client.viewport_width, 0, 100_000), s.optionalNumber(input.client.viewport_height, 0, 100_000),
        s.optionalNumber(input.performance.load_time_ms, 0, 3_600_000), s.optionalText(input.performance.navigation_type, 32),
        0, null));
  }
  if (input.eventType === 'event' || input.eventType === 'custom') {
    let propsJson: string | null = null;
    if (input.props !== undefined) {
      try {
        const serialized = JSON.stringify(input.props);
        if (serialized.length <= 4096) propsJson = serialized;
      } catch { propsJson = null; }
    }
    statements.push(db.prepare(`INSERT INTO events (id, site_id, visitor_id, session_id, event_type, occurred_at, received_at,
      page_url, page_path, event_name, target_url, target_domain, value_number, value_text, props_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), siteKey, input.visitorId, input.sessionId, input.eventType, input.occurredAt, now,
        input.pageUrl, input.pagePath, input.eventName, input.targetUrl,
        input.targetUrl ? targetDomain(input.targetUrl) : null,
        input.valueNumber, input.valueText, propsJson));
  }
  await db.batch(statements);
}

function targetDomain(targetUrl: string | null): string | null {
  if (!targetUrl) return null;
  try { return new URL(targetUrl).hostname.replace(/^www\./i, ''); } catch { return null; }
}
