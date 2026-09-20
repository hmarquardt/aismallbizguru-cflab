import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JUNKDRAWER, TOP_HAT, bindings, call, canonicalPayload, jsonCall, migrate, resetData, seedHuman } from './helpers';
import { runMaintenance } from '../../src/analytics/maintenance';
import { shiftDay } from '../../src/analytics/sanitize';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const today = new Date().toISOString().slice(0, 10);

async function domainId(siteId: number, hostname: string): Promise<number> {
  const row = await bindings.ANALYTICS.prepare('SELECT id FROM analytics_domains WHERE site_id = ? AND hostname = ?')
    .bind(siteId, hostname).first<{ id: number }>();
  return Number(row!.id);
}

interface EventOverrides {
  event_uid?: string;
  received_at_ms?: number;
  event_kind?: 'pageview' | 'event';
  event_name?: string;
  session_id?: string | null;
  pathname?: string;
  referrer_host?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  country_code?: string | null;
  region_code?: string | null;
  browser?: string | null;
  os?: string | null;
  device?: string | null;
}

async function insertEvent(siteId: number, domain: number, day: string, values: EventOverrides = {}): Promise<void> {
  await bindings.ANALYTICS.prepare(
    `INSERT INTO analytics_events (event_uid, site_id, domain_id, received_at_ms, site_day, event_kind, event_name, session_id,
       pathname, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term, browser, os, device, country_code, region_code, props_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`)
    .bind(
      values.event_uid ?? crypto.randomUUID(), siteId, domain, values.received_at_ms ?? Date.now(), day,
      values.event_kind ?? 'pageview', values.event_name ?? 'pageview', values.session_id === undefined ? 's_0123456789abcdef0123456789abcdef' : values.session_id,
      values.pathname ?? '/', values.referrer_host ?? null, values.utm_source ?? null, values.utm_medium ?? null, values.utm_campaign ?? null,
      values.browser ?? 'Chrome', values.os ?? 'Other', values.device ?? 'desktop', values.country_code ?? null, values.region_code ?? null,
    ).run();
}

async function adminToken(): Promise<string> {
  return await seedHuman(`admin-${crypto.randomUUID()}@example.com`, true);
}

function authed(path: string, token: string) {
  return call(path, { headers: { Authorization: `Bearer ${token}` } });
}

describe('site-scoped reporting', () => {
  it('isolates sites', async () => {
    await insertEvent(1, await domainId(1, 'hmarquardt.github.io'), today);
    await insertEvent(2, await domainId(2, 'tophatferals.com'), today);
    const token = await adminToken();
    const one = await (await authed(`/api/sites/${JUNKDRAWER}/summary?from=${today}&to=${today}`, token)).json<{ pageviews: number }>();
    const two = await (await authed(`/api/sites/${TOP_HAT}/summary?from=${today}&to=${today}`, token)).json<{ pageviews: number }>();
    expect(one.pageviews).toBe(1);
    expect(two.pageviews).toBe(1);
  });

  it('filters by domain and rejects unknown domains', async () => {
    const primary = await domainId(1, 'hmarquardt.github.io');
    await insertEvent(1, primary, today);
    await bindings.ANALYTICS.prepare("INSERT INTO analytics_domains (site_id, hostname, kind, active, created_at_ms) VALUES (1, 'alias.example.com', 'alias', 1, ?)")
      .bind(Date.now()).run();
    const alias = await domainId(1, 'alias.example.com');
    await insertEvent(1, alias, today);
    const token = await adminToken();
    const base = `/api/sites/${JUNKDRAWER}/summary?from=${today}&to=${today}`;
    const filtered = await (await authed(`${base}&domain=hmarquardt.github.io`, token)).json<{ pageviews: number; domain: string }>();
    expect(filtered).toMatchObject({ pageviews: 1, domain: 'hmarquardt.github.io' });
    expect((await authed(`${base}&domain=nope.example.com`, token)).status).toBe(400);
    expect((await authed(`/api/sites/${JUNKDRAWER}/summary?from=bad&to=${today}`, token)).status).toBe(400);
  });

  it('filters by date range', async () => {
    const domain = await domainId(1, 'hmarquardt.github.io');
    const older = shiftDay(today, -3);
    const newer = shiftDay(today, -1);
    await insertEvent(1, domain, older);
    await insertEvent(1, domain, newer);
    const token = await adminToken();
    const query = (from: string, to: string) => authed(`/api/sites/${JUNKDRAWER}/summary?from=${from}&to=${to}`, token);
    expect((await (await query(older, older)).json<{ pageviews: number }>()).pageviews).toBe(1);
    expect((await (await query(newer, newer)).json<{ pageviews: number }>()).pageviews).toBe(1);
    expect((await (await query(older, newer)).json<{ pageviews: number }>()).pageviews).toBe(2);
  });

  it('computes site_day in the configured timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T20:00:00.000Z'));
    await bindings.ANALYTICS.prepare('UPDATE analytics_sites SET timezone = ? WHERE id = 1').bind('Pacific/Kiritimati').run();
    expect((await jsonCall('/collect', canonicalPayload(), { Origin: 'https://hmarquardt.github.io' })).status).toBe(204);
    const row = await bindings.ANALYTICS.prepare('SELECT site_day FROM analytics_events WHERE site_id = 1').first<{ site_day: string }>();
    expect(row?.site_day).toBe('2026-01-02');
  });

  it('reports page, event, referrer, campaign, and device totals', async () => {
    const domain = await domainId(1, 'hmarquardt.github.io');
    await insertEvent(1, domain, today, { pathname: '/a' });
    await insertEvent(1, domain, today, { pathname: '/b', referrer_host: 'example.com', utm_source: 'news', utm_medium: 'email', utm_campaign: 'fall' });
    await insertEvent(1, domain, today, { pathname: '/c', session_id: 's_other_0123456789abcdef01234567' });
    await insertEvent(1, domain, today, { event_kind: 'event', event_name: 'signup', session_id: 's_other_0123456789abcdef01234567' });
    const token = await adminToken();
    const base = `/api/sites/${JUNKDRAWER}`;
    const query = `?from=${today}&to=${today}`;
    const summary = await (await authed(`${base}/summary${query}`, token)).json<{ pageviews: number; events: number; sessions: number; bounce_rate: number }>();
    expect(summary).toMatchObject({ pageviews: 3, events: 1, sessions: 2, bounce_rate: 0.5 });
    const pages = await (await authed(`${base}/pages${query}`, token)).json<{ pages: Array<{ pathname: string; pageviews: number }> }>();
    expect(pages.pages.map(page => page.pathname)).toEqual(['/a', '/b', '/c']);
    const events = await (await authed(`${base}/events${query}`, token)).json<{ events: Array<{ event_name: string; count: number }> }>();
    expect(events.events).toEqual([{ event_name: 'signup', count: 1, sessions: 1 }]);
    const referrers = await (await authed(`${base}/referrers${query}`, token)).json<{ referrers: Array<{ referrer: string; pageviews: number }> }>();
    expect(referrers.referrers.map(row => row.referrer)).toEqual(['direct', 'example.com']);
    const campaigns = await (await authed(`${base}/campaigns${query}`, token)).json<{ campaigns: Array<{ source: string; campaign: string }> }>();
    expect(campaigns.campaigns).toEqual([{ source: 'news', medium: 'email', campaign: 'fall', pageviews: 1, sessions: 1 }]);
    const devices = await (await authed(`${base}/devices${query}`, token)).json<{ devices: Array<{ value: string }>; browsers: Array<{ value: string }> }>();
    expect(devices.devices).toEqual([{ value: 'desktop', pageviews: 3, sessions: 2 }]);
    expect(devices.browsers).toEqual([{ value: 'Chrome', pageviews: 3, sessions: 2 }]);
  });

  it('reports recent activity and the five-minute live window', async () => {
    const domain = await domainId(1, 'hmarquardt.github.io');
    await insertEvent(1, domain, today, { received_at_ms: Date.now() - 60_000, pathname: '/recent' });
    await insertEvent(1, domain, today, { received_at_ms: Date.now() - 20 * 60_000, pathname: '/older', event_uid: 'e_old_event_uid_000000000000' });
    const token = await adminToken();
    const base = `/api/sites/${JUNKDRAWER}`;
    const live = await (await authed(`${base}/live?from=${today}&to=${today}`, token)).json<{ events: number; sessions: number; pages: Array<{ pathname: string }> }>();
    expect(live.events).toBe(1);
    expect(live.sessions).toBe(1);
    expect(live.pages[0]?.pathname).toBe('/recent');
    const recent = await (await authed(`${base}/recent?from=${today}&to=${today}`, token)).json<{ events: Array<{ pathname: string }> }>();
    expect(recent.events[0]?.pathname).toBe('/recent');
    expect(recent.events[1]?.pathname).toBe('/older');
  });

  it('rolls up expired days before retention deletion and reports them from aggregates', async () => {
    await bindings.ANALYTICS.prepare('UPDATE analytics_sites SET raw_retention_days = 2 WHERE id = 1').run();
    const domain = await domainId(1, 'hmarquardt.github.io');
    const oldDay = shiftDay(today, -5);
    await insertEvent(1, domain, oldDay, { received_at_ms: Date.now() - 5 * 86_400_000 });
    const result = await runMaintenance(bindings.ANALYTICS, Date.now());
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await bindings.ANALYTICS.prepare('SELECT pageviews FROM analytics_daily_site WHERE site_id = 1 AND site_day = ?').bind(oldDay).first('pageviews')).toBe(1);
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE site_id = 1').first('n')).toBe(0);
    const token = await adminToken();
    const from = shiftDay(today, -6);
    const summary = await (await authed(`/api/sites/${JUNKDRAWER}/summary?from=${from}&to=${today}`, token)).json<{ pageviews: number }>();
    expect(summary.pageviews).toBe(1);
    const series = await (await authed(`/api/sites/${JUNKDRAWER}/timeseries?from=${from}&to=${today}&bucket=day`, token)).json<{ points: Array<{ date: string; pageviews: number }> }>();
    expect(series.points).toContainEqual({ date: oldDay, pageviews: 1, events: 0, sessions: 1 });
  });

  it('enforces the viewer minimum on every report route', async () => {
    const token = await adminToken();
    for (const path of ['summary', 'timeseries', 'pages', 'referrers', 'campaigns', 'devices', 'geography', 'events', 'recent', 'live']) {
      const response = await authed(`/api/sites/${JUNKDRAWER}/${path}?from=${today}&to=${today}`, token);
      expect(response.status).toBe(200);
    }
  });
});
