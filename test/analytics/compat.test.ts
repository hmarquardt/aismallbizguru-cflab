import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../../src/local';
import type { Bindings } from '../../src/types';
import { bindings, call, legacyPayload, migrate, resetData, seedHuman, testEnv } from './helpers';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
});

function cflab(path: string, token?: string) {
  return local.fetch(new Request(`http://localhost${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), testEnv() as unknown as Bindings);
}

const today = new Date().toISOString().slice(0, 10);

describe('legacy deployed snippet compatibility', () => {
  it('serves the deployed lab.aismallbizguru.com collector path from the Analytics Worker', async () => {
    const response = await call('https://lab.aismallbizguru.com/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://hmarquardt.github.io' },
      body: JSON.stringify(legacyPayload()),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('keeps the legacy CFLab dashboard endpoints working through the dual-write bridge', async () => {
    const token = await seedHuman('dash-admin@example.com', true);
    const collect = await call('https://lab.aismallbizguru.com/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://hmarquardt.github.io' },
      body: JSON.stringify(legacyPayload()),
    });
    expect(collect.status).toBe(200);

    const summary = await cflab(`/api/analytics/summary?site_id=junkdrawer&from=${today}&to=${today}`, token);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ site_id: 'junkdrawer', pageviews: 1, visitors: 1, sessions: 1 });

    const timeseries = await cflab(`/api/analytics/timeseries?site_id=junkdrawer&from=${today}&to=${today}&bucket=day`, token);
    expect((await timeseries.json<{ points: unknown[] }>()).points).toHaveLength(1);

    const pages = await cflab(`/api/analytics/pages?site_id=junkdrawer&from=${today}&to=${today}`, token);
    expect((await pages.json<{ pages: Array<{ path: string }> }>()).pages[0]?.path).toBe('/junkdrawer/page.html');

    const referrers = await cflab(`/api/analytics/referrers?site_id=junkdrawer&from=${today}&to=${today}`, token);
    expect((await referrers.json<{ referrers: Array<{ domain: string }> }>()).referrers[0]?.domain).toBe('example.com');

    const recent = await cflab('/api/analytics/recent?site_id=junkdrawer&limit=5', token);
    expect((await recent.json<{ visits: unknown[] }>()).visits).toHaveLength(1);
  });

  it('also accepts the legacy path on the cflab hostname', async () => {
    const response = await call('https://cflab.aismallbizguru.com/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://tophatferals.com' },
      body: JSON.stringify(legacyPayload({ site_id: 'top-hat-ferals' })),
    });
    expect(response.status).toBe(200);
    const row = await bindings.ANALYTICS.prepare('SELECT site_id FROM analytics_events').first<{ site_id: number }>();
    expect(row?.site_id).toBe(2);
  });

  it('preserves CORS preflight for deployed snippets', async () => {
    const preflight = await call('https://lab.aismallbizguru.com/api/analytics/collect', {
      method: 'OPTIONS',
      headers: { Origin: 'https://hmarquardt.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://hmarquardt.github.io');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});
