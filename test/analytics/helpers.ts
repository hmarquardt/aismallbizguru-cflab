import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { AnalyticsBindings, CflabAuthBinding } from '../../src/analytics/env';
import type { Bindings } from '../../src/types';
import { createSession, sessionUser } from '../../src/auth/human';
import analyticsWorker from '../../src/analytics/index';

export const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_ANALYTICS_MIGRATIONS: { name: string; queries: string[] }[];
};

export const JUNKDRAWER = 'as_i5CfW5DyIwS3Zd0prGvRkF';
export const TOP_HAT = 'as_Nrpoc6cKB5afip6oykD2Ab';
export const JUNKDRAWER_ORIGIN = 'https://hmarquardt.github.io';
export const TOP_HAT_ORIGIN = 'https://tophatferals.com';
export const ANALYTICS_ORIGIN = 'https://analytics.aismallbizguru.com';

export async function migrate(): Promise<void> {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.ANALYTICS, bindings.TEST_ANALYTICS_MIGRATIONS);
}

// The stub mirrors CFLab's HumanAuthService: only { userId, isAdmin } crosses
// the service-binding boundary.
export function authStub(): CflabAuthBinding {
  return {
    async verifyHumanSession(token: string) {
      if (!/^cflu_[0-9a-f]{64}$/.test(token)) return null;
      try {
        const user = await sessionUser(bindings, token);
        return { userId: user.id, isAdmin: user.is_admin };
      } catch {
        return null;
      }
    },
  };
}

export function testEnv(overrides: Partial<AnalyticsBindings> = {}): AnalyticsBindings {
  return {
    ...bindings,
    CFLAB: authStub(),
    RL_ANALYTICS: { limit: async () => ({ success: true }) },
    ...overrides,
  } as unknown as AnalyticsBindings;
}

export async function call(path: string, init: RequestInit = {}, environment: AnalyticsBindings = testEnv()): Promise<Response> {
  const url = path.startsWith('http') ? path : `${ANALYTICS_ORIGIN}${path}`;
  return await analyticsWorker.fetch(new Request(url, init), environment, {} as ExecutionContext);
}

export async function jsonCall(path: string, body: unknown, headers: Record<string, string> = {}, environment: AnalyticsBindings = testEnv()): Promise<Response> {
  return await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, environment);
}

export function canonicalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: JUNKDRAWER,
    kind: 'pageview',
    name: 'pageview',
    path: '/junkdrawer/page.html',
    session: 's_0123456789abcdef0123456789abcdef',
    event_uid: `e_${crypto.randomUUID().replace(/-/g, '')}`,
    referrer: 'https://example.com/ref?campaign=1',
    utm: { source: 'newsletter', medium: 'email', campaign: 'september' },
    props: { plan: 'pro', count: 3, trial: true },
    ...overrides,
  };
}

export function legacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site_id: 'junkdrawer',
    event_type: 'pageview',
    visitor_id: 'v_test_1',
    session_id: 's_test_1',
    occurred_at: new Date().toISOString(),
    page: { url: 'https://hmarquardt.github.io/junkdrawer/page.html', host: 'hmarquardt.github.io', path: '/junkdrawer/page.html', query: '', title: 'Test Page' },
    referrer: { url: 'https://example.com/ref?x=1', domain: 'example.com' },
    utm: { source: 'newsletter', medium: 'email', campaign: 'september' },
    client: { language: 'en-US', timezone: 'America/Indiana/Indianapolis', screen_width: 1440, screen_height: 900, viewport_width: 1200, viewport_height: 800, user_agent: 'Mozilla/5.0 Chrome/120 Safari/537.36' },
    performance: { load_time_ms: 120, navigation_type: 'navigate' },
    ...overrides,
  };
}

export async function seedHuman(email: string, isAdmin: boolean): Promise<string> {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
    .bind(userId, email, isAdmin ? 1 : 0, now, now).run();
  const session = await createSession(bindings, userId);
  return session.token;
}

export async function seedMembership(siteId: number, userId: string, role: 'owner' | 'editor' | 'viewer'): Promise<void> {
  await bindings.ANALYTICS.prepare('INSERT OR REPLACE INTO analytics_site_memberships (site_id, user_id, role, created_at_ms) VALUES (?, ?, ?, ?)')
    .bind(siteId, userId, role, Date.now()).run();
}

export async function userIdForToken(token: string): Promise<string> {
  const user = await sessionUser(bindings, token);
  return user.id;
}

export async function resetData(): Promise<void> {
  await bindings.ANALYTICS.batch([
    bindings.ANALYTICS.prepare('DELETE FROM analytics_events'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_event_names'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_site_memberships'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_daily_site'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_daily_domains'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_daily_pages'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_daily_referrers'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_daily_events'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_domains WHERE site_id NOT IN (1, 2)'),
    bindings.ANALYTICS.prepare('DELETE FROM analytics_sites WHERE id NOT IN (1, 2)'),
    bindings.ANALYTICS.prepare('UPDATE analytics_sites SET active = 1, respect_dnt = 1, respect_gpc = 1, raw_retention_days = 90, timezone = \'UTC\' WHERE id IN (1, 2)'),
    bindings.ANALYTICS.prepare('UPDATE analytics_domains SET active = 1 WHERE site_id IN (1, 2)'),
    bindings.ANALYTICS.prepare('DELETE FROM events'),
    bindings.ANALYTICS.prepare('DELETE FROM pageviews'),
    bindings.ANALYTICS.prepare('DELETE FROM sessions'),
    bindings.ANALYTICS.prepare('DELETE FROM visitors'),
  ]);
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM password_reset_tokens'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM project_memberships'),
    bindings.DB.prepare('DELETE FROM users'),
  ]);
}

export async function eventCount(siteId = 1): Promise<number> {
  const row = await bindings.ANALYTICS.prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE site_id = ?').bind(siteId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
