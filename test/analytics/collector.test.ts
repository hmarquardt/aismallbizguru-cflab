import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindings, call, canonicalPayload, eventCount, jsonCall, legacyPayload, migrate, resetData, testEnv,
} from './helpers';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
});

const origin = { Origin: 'https://hmarquardt.github.io' };

describe('canonical collector', () => {
  it('records a valid pageview with derived agent and session', async () => {
    const response = await jsonCall('/collect', canonicalPayload(), { ...origin, 'User-Agent': 'Mozilla/5.0 Chrome/120 Safari/537.36', 'CF-IPCountry': 'us', 'CF-Region-Code': 'in' });
    expect(response.status).toBe(204);
    const row = await bindings.ANALYTICS.prepare('SELECT * FROM analytics_events WHERE site_id = 1').first<Record<string, unknown>>();
    expect(row).toMatchObject({
      event_kind: 'pageview', event_name: 'pageview', pathname: '/junkdrawer/page.html',
      session_id: 's_0123456789abcdef0123456789abcdef', browser: 'Chrome', os: 'Other', device: 'desktop',
      country_code: 'US', region_code: 'IN', referrer_host: 'example.com', utm_source: 'newsletter',
    });
    expect(row?.props_json).toBeNull();
  });

  it('records a valid custom event with constrained properties and registers the name', async () => {
    const response = await jsonCall('/collect', canonicalPayload({ kind: 'event', name: 'signup', props: { plan: 'pro', count: 3, trial: true } }), origin);
    expect(response.status).toBe(204);
    const row = await bindings.ANALYTICS.prepare('SELECT event_kind, event_name, props_json FROM analytics_events WHERE site_id = 1').first<{ event_kind: string; event_name: string; props_json: string }>();
    expect(row?.event_kind).toBe('event');
    expect(row?.event_name).toBe('signup');
    expect(JSON.parse(row!.props_json)).toEqual({ plan: 'pro', count: 3, trial: true });
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM analytics_event_names WHERE site_id = 1 AND event_name = ?').bind('signup').first('n')).toBe(1);
  });

  it('accepts both the opaque public id and the legacy key', async () => {
    expect((await jsonCall('/collect', canonicalPayload(), origin)).status).toBe(204);
    expect((await jsonCall('/collect', canonicalPayload({ site: 'junkdrawer' }), origin)).status).toBe(204);
    expect(await eventCount()).toBe(2);
  });

  it('returns 204 without storing for unknown and inactive sites', async () => {
    expect((await jsonCall('/collect', canonicalPayload({ site: 'as_zzzzzzzzzzzzzzzzzzzzzz' }), origin)).status).toBe(204);
    await bindings.ANALYTICS.prepare('UPDATE analytics_sites SET active = 0 WHERE id = 1').run();
    expect((await jsonCall('/collect', canonicalPayload(), origin)).status).toBe(204);
    expect(await eventCount()).toBe(0);
  });

  it('enforces active domain origins', async () => {
    expect((await jsonCall('/collect', canonicalPayload(), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await jsonCall('/collect', canonicalPayload())).status).toBe(403);
    await bindings.ANALYTICS.prepare("UPDATE analytics_domains SET active = 0 WHERE site_id = 1").run();
    expect((await jsonCall('/collect', canonicalPayload(), origin)).status).toBe(403);
    expect(await eventCount()).toBe(0);
  });

  it('deduplicates repeated event UIDs', async () => {
    const payload = canonicalPayload();
    expect((await jsonCall('/collect', payload, origin)).status).toBe(204);
    expect((await jsonCall('/collect', payload, origin)).status).toBe(204);
    expect(await eventCount()).toBe(1);
  });

  it('rejects oversized bodies, malformed JSON, and wrong content types', async () => {
    expect((await jsonCall('/collect', canonicalPayload({ props: { big: 'x'.repeat(9000) } }), origin)).status).toBe(413);
    const malformed = await call('/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', ...origin }, body: '{' });
    expect(malformed.status).toBe(400);
    const wrongType = await call('/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...origin }, body: '{}' });
    expect(wrongType.status).toBe(415);
  });

  it('rejects invalid event names and property shapes', async () => {
    const props = (value: Record<string, unknown>) => canonicalPayload({ kind: 'event', name: 'props_test', props: value });
    expect((await jsonCall('/collect', canonicalPayload({ kind: 'event', name: 'bad name!' }), origin)).status).toBe(400);
    expect((await jsonCall('/collect', props({ 'bad key': 'x' }), origin)).status).toBe(400);
    expect((await jsonCall('/collect', props({ nested: { a: 1 } }), origin)).status).toBe(400);
    expect((await jsonCall('/collect', props({ arr: [1, 2] }), origin)).status).toBe(400);
    expect((await jsonCall('/collect', props({ long: 'x'.repeat(201) }), origin)).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${index}`, 'v']));
    expect((await jsonCall('/collect', props(many), origin)).status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('caps automatic event-name creation at 100 per site', async () => {
    const statements = Array.from({ length: 100 }, (_, index) =>
      bindings.ANALYTICS.prepare('INSERT INTO analytics_event_names (site_id, event_name, created_at_ms) VALUES (1, ?, ?)').bind(`seeded_${index}`, Date.now()));
    await bindings.ANALYTICS.batch(statements);
    expect((await jsonCall('/collect', canonicalPayload({ kind: 'event', name: 'overflow' }), origin)).status).toBe(400);
    expect((await jsonCall('/collect', canonicalPayload({ kind: 'event', name: 'seeded_5' }), origin)).status).toBe(204);
  });

  it('honors DNT and GPC when the site requires it', async () => {
    expect((await jsonCall('/collect', canonicalPayload(), { ...origin, DNT: '1' })).status).toBe(204);
    expect((await jsonCall('/collect', canonicalPayload(), { ...origin, 'Sec-GPC': '1' })).status).toBe(204);
    expect(await eventCount()).toBe(0);
    await bindings.ANALYTICS.prepare('UPDATE analytics_sites SET respect_dnt = 0 WHERE id = 1').run();
    expect((await jsonCall('/collect', canonicalPayload(), { ...origin, DNT: '1' })).status).toBe(204);
    expect(await eventCount()).toBe(1);
  });

  it('drops obvious crawler traffic', async () => {
    expect((await jsonCall('/collect', canonicalPayload(), { ...origin, 'User-Agent': 'Googlebot/2.1' })).status).toBe(204);
    expect(await eventCount()).toBe(0);
  });

  it('strips query strings and normalizes referrers, UTMs, and session ids', async () => {
    await jsonCall('/collect', canonicalPayload({
      path: '/pricing?secret=1#frag',
      referrer: 'https://www.example.com/ref?secret=1',
      utm: { source: 's', medium: 'm', campaign: 'c', content: 'ct', term: 't' },
      session: 'not a session',
    }), origin);
    const row = await bindings.ANALYTICS.prepare('SELECT pathname, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term, session_id FROM analytics_events').first<Record<string, unknown>>();
    expect(row).toMatchObject({
      pathname: '/pricing', referrer_host: 'example.com', utm_source: 's', utm_medium: 'm',
      utm_campaign: 'c', utm_content: 'ct', utm_term: 't', session_id: null,
    });
  });

  it('enforces the rate limit binding', async () => {
    const limited = testEnv({ RL_ANALYTICS: { limit: async () => ({ success: false }) } });
    expect((await jsonCall('/collect', canonicalPayload(), origin, limited)).status).toBe(429);
    expect(await eventCount()).toBe(0);
  });
});

describe('legacy collector compatibility', () => {
  it('records a legacy pageview in the new and legacy tables', async () => {
    const response = await jsonCall('/api/analytics/collect', legacyPayload(), origin);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await eventCount()).toBe(1);
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM pageviews').first('n')).toBe(1);
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(1);
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM visitors').first('n')).toBe(1);
  });

  it('accepts legacy custom events and stores them in both models', async () => {
    const response = await jsonCall('/api/analytics/collect', legacyPayload({ event_type: 'custom', event_name: 'signup', props: { plan: 'pro' } }), origin);
    expect(response.status).toBe(200);
    const event = await bindings.ANALYTICS.prepare('SELECT event_kind, event_name FROM analytics_events').first<{ event_kind: string; event_name: string }>();
    expect(event).toEqual({ event_kind: 'event', event_name: 'signup' });
    expect(await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
  });

  it('keeps the deployed path working for Top Hat Ferals', async () => {
    const response = await call('https://lab.aismallbizguru.com/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://tophatferals.com' },
      body: JSON.stringify(legacyPayload({ site_id: 'top-hat-ferals', page: { url: 'https://tophatferals.com/', host: 'tophatferals.com', path: '/', query: '', title: 'Top Hat Ferals' } })),
    });
    expect(response.status).toBe(200);
    const row = await bindings.ANALYTICS.prepare('SELECT site_id, domain_id FROM analytics_events').first<{ site_id: number; domain_id: number }>();
    expect(row?.site_id).toBe(2);
  });

  it('records without Origin using the payload document host', async () => {
    expect((await jsonCall('/api/analytics/collect', legacyPayload())).status).toBe(200);
    expect(await eventCount()).toBe(1);
  });

  it('falls through to the payload host when Origin is malformed', async () => {
    expect((await jsonCall('/api/analytics/collect', legacyPayload(), { Origin: 'not a url' })).status).toBe(200);
    expect(await eventCount()).toBe(1);
  });

  it('records without Origin or payload host using the Referer host', async () => {
    const payload = legacyPayload({ page: { url: 'https://hmarquardt.github.io/x', host: '', path: '/x', query: '', title: '' } });
    const response = await jsonCall('/api/analytics/collect', payload, { Referer: 'https://hmarquardt.github.io/junkdrawer/page.html' });
    expect(response.status).toBe(200);
    expect(await eventCount()).toBe(1);
  });

  it('succeeds without recording when no source hostname is available', async () => {
    const payload = legacyPayload({ page: { url: 'https://hmarquardt.github.io/x', host: '', path: '/x', query: '', title: '' } });
    const response = await jsonCall('/api/analytics/collect', payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await eventCount()).toBe(0);
  });

  it('rejects a mismatched source hostname without recording', async () => {
    const payload = legacyPayload({ page: { url: 'https://evil.example/x', host: 'evil.example', path: '/x', query: '', title: '' } });
    expect((await jsonCall('/api/analytics/collect', payload)).status).toBe(403);
    // The first well-formed source is authoritative even when Referer looks valid.
    expect((await jsonCall('/api/analytics/collect', payload, { Referer: 'https://hmarquardt.github.io/junkdrawer/page.html' })).status).toBe(403);
    expect(await eventCount()).toBe(0);
  });

  it('rejects unknown sites, invalid origins, malformed bodies, and oversized requests', async () => {
    expect((await jsonCall('/api/analytics/collect', legacyPayload({ site_id: 'unknown' }), origin)).status).toBe(204);
    expect((await jsonCall('/api/analytics/collect', legacyPayload(), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await jsonCall('/api/analytics/collect', legacyPayload({ event_type: 'hack' }), origin)).status).toBe(400);
    expect((await jsonCall('/api/analytics/collect', legacyPayload({ visitor_id: '' }), origin)).status).toBe(400);
    expect((await jsonCall('/api/analytics/collect', legacyPayload({ occurred_at: 'nope' }), origin)).status).toBe(400);
    const big = await call('/api/analytics/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', ...origin }, body: JSON.stringify(legacyPayload({ props: { text: 'x'.repeat(40_000) } })) });
    expect(big.status).toBe(413);
    expect(await eventCount()).toBe(0);
  });
});
