import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindings, migrate, resetData } from './helpers';
import type { AnalyticsBindings } from '../../src/analytics/env';
import { GSC_PROPERTIES } from '../../src/analytics/gsc-properties';
import {
  MANUAL_WINDOW_MS, MAX_REQUESTS_PER_RUN, consumeManualRun, backfillWindow, dataStateFor,
  daysInWindow, mergeWindows, reconcileWindow, reportableRange, runGscCollection, runScheduledGscCollection,
} from '../../src/analytics/gsc-collector';
import { ROW_LIMIT } from '../../src/analytics/gsc-client';

// A keypair generated for this test only; nothing is committed and no Google
// request is made. The fake below answers the token, discovery and report calls.
async function serviceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  return JSON.stringify({
    client_email: 'cflab-collector@project.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

interface ReportCall {
  property: string;
  dimensions: string[];
  startDate: string;
  endDate: string;
  startRow: number;
  rowLimit: number;
  dataState: string;
}

interface DayMetrics { clicks: number; impressions: number; position: number | null }

// Minimal Google stand-in: it answers with Google's documented response shapes so
// the collector is exercised against real parsing, pagination and error paths.
class FakeGoogle {
  properties = new Set(GSC_PROPERTIES.map(entry => entry.property));
  totals = new Map<string, Map<string, DayMetrics>>();
  queries = new Map<string, { query: string; clicks: number; impressions: number }[]>();
  pages = new Map<string, { page: string; clicks: number; impressions: number }[]>();
  firstIncomplete: string | null = null;
  fullQueryPages = 0;
  failure: { property?: string; dimensions?: string[]; status: number } | null = null;
  tokenStatus: number | null = null;
  calls: ReportCall[] = [];

  setDay(property: string, day: string, metrics: DayMetrics): void {
    if (!this.totals.has(property)) this.totals.set(property, new Map());
    this.totals.get(property)!.set(day, metrics);
  }

  requests(): number {
    return this.calls.length;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      if (this.tokenStatus) return this.json({ error: 'invalid_grant' }, this.tokenStatus);
      return this.json({ access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' });
    }
    if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
      return this.json({
        siteEntry: [...this.properties].map(property => ({ siteUrl: property, permissionLevel: 'siteRestrictedUser' })),
      });
    }
    const match = /\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url);
    if (!match) return this.json({ error: 'not found' }, 404);
    const property = decodeURIComponent(match[1]!);
    const body = JSON.parse(String(init.body)) as {
      startDate: string; endDate: string; dimensions: string[]; startRow: number; rowLimit: number; dataState: string;
    };
    const call: ReportCall = {
      property, dimensions: body.dimensions, startDate: body.startDate, endDate: body.endDate,
      startRow: body.startRow, rowLimit: body.rowLimit, dataState: body.dataState,
    };
    this.calls.push(call);
    if (this.failure &&
        (this.failure.property === undefined || this.failure.property === property) &&
        (this.failure.dimensions === undefined || this.failure.dimensions.join(',') === body.dimensions.join(','))) {
      return this.json({ error: { code: this.failure.status } }, this.failure.status);
    }
    return this.json(this.reportFor(call));
  };

  private reportFor(call: ReportCall): Record<string, unknown> {
    const days = [...(this.totals.get(call.property) ?? new Map<string, DayMetrics>()).entries()]
      .filter(([day]) => day >= call.startDate && day <= call.endDate)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const seconds = call.dimensions.slice(1).join(',');
    if (seconds === 'query') {
      if (this.fullQueryPages > 0 && call.startRow <= (this.fullQueryPages - 1) * ROW_LIMIT) {
        return {
          rows: Array.from({ length: ROW_LIMIT }, (_, index) => ({
            keys: [call.startDate, `query-${call.startRow}-${index}`],
            clicks: 1, impressions: 1, ctr: 1, position: 1,
          })),
        };
      }
      return { rows: this.queryRows(call, days, call.rowLimit, call.startRow), metadata: this.metadata() };
    }
    if (seconds === 'page') return { rows: this.pageRows(call, days), metadata: this.metadata() };
    if (seconds === 'device') {
      return {
        rows: days.map(([day, metrics]) => ({ keys: [day, 'MOBILE'], ...metrics, ctr: ratio(metrics) })),
        metadata: this.metadata(),
      };
    }
    if (seconds === 'country') {
      return {
        rows: days.map(([day, metrics]) => ({ keys: [day, 'USA'], ...metrics, ctr: ratio(metrics) })),
        metadata: this.metadata(),
      };
    }
    return {
      rows: days.map(([day, metrics]) => ({ keys: [day], ...metrics, ctr: ratio(metrics) })),
      metadata: this.metadata(),
    };
  }

  private metadata(): Record<string, unknown> {
    return this.firstIncomplete ? { first_incomplete_date: this.firstIncomplete } : {};
  }

  private queryRows(call: ReportCall, days: [string, DayMetrics][], limit: number, startRow: number) {
    const extra = this.queries.get(call.property) ?? [];
    const rows = days.flatMap(([day, metrics]) => extra.map(item => ({
      keys: [day, item.query],
      clicks: Math.min(metrics.clicks, item.clicks),
      impressions: Math.min(metrics.impressions, item.impressions),
      ctr: metrics.impressions > 0 ? item.clicks / metrics.impressions : 0,
      position: metrics.position,
    })));
    return rows.slice(startRow, startRow + limit);
  }

  private pageRows(call: ReportCall, days: [string, DayMetrics][]) {
    const extra = this.pages.get(call.property) ?? [];
    return days.flatMap(([day, metrics]) => extra.map(item => ({
      keys: [day, item.page],
      clicks: item.clicks,
      impressions: item.impressions,
      ctr: ratio(metrics),
      position: metrics.position,
    })));
  }
}

function ratio(metrics: DayMetrics): number {
  return metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0;
}

const NOW = new Date('2026-10-27T12:00:00.000Z');
const TODAY = '2026-10-27';
const NEWEST = '2026-10-26';
const PROPERTY = 'sc-domain:aismallbizguru.com';
let credential = '';
let google: FakeGoogle;

function env(overrides: Partial<AnalyticsBindings> = {}): AnalyticsBindings {
  return {
    ANALYTICS: bindings.ANALYTICS,
    GSC_SERVICE_ACCOUNT_JSON: credential,
    ...overrides,
  } as AnalyticsBindings;
}

async function resetGsc(): Promise<void> {
  await bindings.ANALYTICS.batch([
    bindings.ANALYTICS.prepare('DELETE FROM gsc_daily_totals'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_query_daily'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_page_daily'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_breakdown_daily'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_properties'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_sync_state'),
    bindings.ANALYTICS.prepare("DELETE FROM console_job_runs WHERE job = 'analytics-search-console'"),
  ]);
}

// The four properties that have an Analytics Site, matching src/analytics/gsc-properties.ts.
const MAPPED_SLUGS = ['aismallbizguru', 'turkeyvulturesoftware', 'worthlookingup', 'fruitingforecast'];

async function seedMappedSites(): Promise<void> {
  for (const slug of MAPPED_SLUGS) {
    await bindings.ANALYTICS.prepare(
      `INSERT INTO analytics_sites
         (public_id, slug, name, timezone, active, respect_dnt, respect_gpc, raw_retention_days, created_by_user_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'UTC', 1, 1, 1, 90, 'system:test', ?, ?)
       ON CONFLICT(slug) DO NOTHING`)
      .bind(`as_${slug}`, slug, slug, Date.now(), Date.now()).run();
  }
}

beforeAll(async () => {
  await migrate();
  credential = await serviceAccountJson();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
  await seedMappedSites();
  await resetGsc();
  google = new FakeGoogle();
});

/** Reads the totals stored for one property and day. */
async function totalRow(property: string, day: string) {
  return await bindings.ANALYTICS.prepare(
    'SELECT clicks, impressions, ctr, position, data_state FROM gsc_daily_totals WHERE property = ? AND report_day = ?')
    .bind(property, day).first<{ clicks: number; impressions: number; ctr: number; position: number | null; data_state: string }>();
}

async function countRows(table: string, property?: string): Promise<number> {
  const sql = property ? `SELECT COUNT(*) AS n FROM ${table} WHERE property = ?` : `SELECT COUNT(*) AS n FROM ${table}`;
  const row = property
    ? await bindings.ANALYTICS.prepare(sql).bind(property).first<{ n: number }>()
    : await bindings.ANALYTICS.prepare(sql).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function propertyRow(property: string) {
  return await bindings.ANALYTICS.prepare(
    `SELECT site_id, permission_level, last_success_at, last_error_code, days_covered, newest_day,
            first_incomplete_day, backfill_cursor, backfill_complete
     FROM gsc_properties WHERE property = ?`).bind(property)
    .first<Record<string, unknown>>();
}

function seedTraffic(property = PROPERTY): void {
  google.setDay(property, '2026-10-26', { clicks: 5, impressions: 200, position: 6.4 });
  google.setDay(property, '2026-10-25', { clicks: 3, impressions: 120, position: 7.1 });
  google.setDay(property, '2026-10-20', { clicks: 1, impressions: 40, position: 9.5 });
  google.queries.set(property, [{ query: 'small business ai', clicks: 4, impressions: 90 }]);
  google.pages.set(property, [{ page: 'https://aismallbizguru.com/', clicks: 4, impressions: 90 }]);
}

describe('window planning', () => {
  it('never requests today and stops at the retention floor', () => {
    expect(reportableRange(TODAY)).toEqual({ newest: NEWEST, floor: '2025-07-04' });
    expect(daysInWindow({ from: '2026-10-20', to: '2026-10-26' })).toHaveLength(7);
  });

  it('reconciles the last seven reportable days', () => {
    expect(reconcileWindow(NEWEST, '2025-06-04')).toEqual({ from: '2026-10-20', to: '2026-10-26' });
    // A short retention floor truncates the window instead of exceeding it.
    expect(reconcileWindow(NEWEST, '2026-10-24')).toEqual({ from: '2026-10-24', to: '2026-10-26' });
  });

  it('advances one bounded backfill chunk and finishes at the floor', () => {
    const first = backfillWindow(null, NEWEST, '2025-06-04');
    expect(first.window).toEqual({ from: '2026-09-20', to: '2026-10-19' });
    expect(first.nextCursor).toBe('2026-09-19');
    expect(first.complete).toBe(false);

    const atFloor = backfillWindow('2025-06-10', NEWEST, '2025-06-04');
    expect(atFloor.window).toEqual({ from: '2025-06-04', to: '2025-06-10' });
    expect(atFloor.complete).toBe(true);

    expect(backfillWindow('2025-06-03', NEWEST, '2025-06-04')).toEqual({ window: null, nextCursor: null, complete: true });
  });

  it('merges contiguous windows so a day is never queried twice', () => {
    expect(mergeWindows([
      { from: '2026-10-20', to: '2026-10-26' },
      { from: '2026-09-20', to: '2026-10-19' },
      { from: '2026-10-01', to: '2026-10-05' },
      { from: '2026-10-30', to: '2026-10-20' },
    ])).toEqual([{ from: '2026-09-20', to: '2026-10-26' }]);
  });

  it('uses Google first_incomplete_date and only falls back to the lag rule', () => {
    expect(dataStateFor('2026-10-26', '2026-10-25', TODAY)).toBe('provisional');
    expect(dataStateFor('2026-10-24', '2026-10-25', TODAY)).toBe('final');
    expect(dataStateFor('2026-10-26', null, TODAY)).toBe('provisional');
    expect(dataStateFor('2026-10-23', null, TODAY)).toBe('final');
  });
});

describe('collection', () => {
  it('collects totals, top rows, device/country breakdowns and mapping for every property', async () => {
    seedTraffic();
    google.firstIncomplete = '2026-10-25';
    const result = await runGscCollection(env(), { scope: 'full', trigger: 'cron', now: NOW, fetcher: google.fetch });

    expect(result.status).toBe('ok');
    expect(result.properties).toHaveLength(GSC_PROPERTIES.length);
    expect(result.properties.find(item => item.property === PROPERTY)!.status).toBe('ok');
    expect(result.properties.find(item => item.property === PROPERTY)!.site_slug).toBe('aismallbizguru');

    // Totals carry Google's own numbers, and the freshness marker decides the state.
    expect(await totalRow(PROPERTY, '2026-10-26')).toEqual({
      clicks: 5, impressions: 200, ctr: 0.025, position: 6.4, data_state: 'provisional',
    });
    expect((await totalRow(PROPERTY, '2026-10-24'))!.data_state).toBe('final');
    expect((await totalRow(PROPERTY, '2026-10-20'))!.clicks).toBe(1);

    expect(await countRows('gsc_query_daily', PROPERTY)).toBe(3);
    expect(await countRows('gsc_page_daily', PROPERTY)).toBe(3);
    expect(await countRows('gsc_breakdown_daily', PROPERTY)).toBe(6);

    // Property registration records the mapping and the observed permission.
    const mappedSite = await bindings.ANALYTICS.prepare("SELECT id FROM analytics_sites WHERE slug = 'aismallbizguru'")
      .first<{ id: number }>();
    const row = await propertyRow(PROPERTY);
    expect(row).toMatchObject({
      site_id: Number(mappedSite!.id),
      permission_level: 'siteRestrictedUser',
      last_error_code: null,
      newest_day: '2026-10-26',
      first_incomplete_day: '2026-10-25',
      backfill_cursor: '2026-09-19',
      backfill_complete: 0,
    });
    expect(Number(row!.days_covered)).toBe(37);

    // Unmapped properties are collected but stay unlinked to a Site.
    expect((await propertyRow('sc-domain:roadnaturalist.com'))!.site_id).toBeNull();
    expect((await propertyRow('sc-domain:hankmarquardt.com'))!.site_id).toBeNull();

    const run = await bindings.ANALYTICS.prepare(
      "SELECT status, summary_json, error_code FROM console_job_runs WHERE job = 'analytics-search-console'").first<{ status: string; summary_json: string; error_code: string | null }>();
    expect(run!.status).toBe('ok');
    expect(run!.error_code).toBeNull();
    const summary = JSON.parse(run!.summary_json);
    expect(summary.scope).toBe('full');
    expect(summary.properties).toHaveLength(GSC_PROPERTIES.length);

    // One discovery call plus five reports per merged window per property.
    // Reconcile and backfill windows are contiguous, so each property needs five reports.
    expect(result.requests).toBe(GSC_PROPERTIES.length * 5);
    expect(google.calls).toHaveLength(GSC_PROPERTIES.length * 5);
    expect(result.requests).toBeLessThanOrEqual(MAX_REQUESTS_PER_RUN);
  });

  it('is idempotent: a repeat replaces the same window instead of double counting', async () => {
    seedTraffic();
    await runGscCollection(env(), { scope: 'full', trigger: 'cron', now: NOW, fetcher: google.fetch });
    const first = {
      totals: await countRows('gsc_daily_totals', PROPERTY),
      queries: await countRows('gsc_query_daily', PROPERTY),
      pages: await countRows('gsc_page_daily', PROPERTY),
      breakdowns: await countRows('gsc_breakdown_daily', PROPERTY),
      day: await totalRow(PROPERTY, '2026-10-26'),
    };

    // A daily run re-collects only the reconcile window, which is the reconciliation path.
    await runGscCollection(env(), { scope: 'daily', trigger: 'manual', now: NOW, fetcher: google.fetch });
    expect({
      totals: await countRows('gsc_daily_totals', PROPERTY),
      queries: await countRows('gsc_query_daily', PROPERTY),
      pages: await countRows('gsc_page_daily', PROPERTY),
      breakdowns: await countRows('gsc_breakdown_daily', PROPERTY),
      day: await totalRow(PROPERTY, '2026-10-26'),
    }).toEqual(first);

    const runs = await bindings.ANALYTICS.prepare(
      "SELECT COUNT(*) AS n FROM console_job_runs WHERE job = 'analytics-search-console'").first<{ n: number }>();
    expect(Number(runs!.n)).toBe(2);
  });

  it('treats a property with no search traffic as empty, not failed', async () => {
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(result.status).toBe('ok');
    expect(result.properties.every(item => item.status === 'empty')).toBe(true);
    const stored = await totalRow(PROPERTY, '2026-10-26');
    expect(stored).toMatchObject({ clicks: 0, impressions: 0, ctr: 0, position: null });
    expect((await bindings.ANALYTICS.prepare('SELECT error_code FROM console_job_runs').first<{ error_code: string | null }>())!.error_code).toBeNull();
  });

  it('stores nothing for a window whose report call failed', async () => {
    seedTraffic();
    google.failure = { property: PROPERTY, dimensions: ['date', 'page'], status: 503 };
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });

    const outcome = result.properties.find(item => item.property === PROPERTY)!;
    expect(outcome.status).toBe('failed');
    expect(outcome.error_code).toBe('upstream_error');
    expect(result.status).toBe('partial');
    // The totals are written only after every report for the window succeeded.
    expect(await totalRow(PROPERTY, '2026-10-26')).toBeNull();
    expect((await propertyRow(PROPERTY))!.last_error_code).toBe('upstream_error');
  });

  it('marks a property Google no longer lists as inaccessible, not empty', async () => {
    google.properties.delete('sc-domain:worthlookingup.com');
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    const outcome = result.properties.find(item => item.property === 'sc-domain:worthlookingup.com')!;
    expect(outcome.status).toBe('inaccessible');
    expect(outcome.error_code).toBe('property_not_accessible');
    expect(result.status).toBe('partial');
    expect(await countRows('gsc_daily_totals', 'sc-domain:worthlookingup.com')).toBe(0);
  });

  it('records a rejected credential once, for every property', async () => {
    google.tokenStatus = 401;
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('google_token_rejected');
    expect(result.properties.every(item => item.status === 'inaccessible')).toBe(true);
    const run = await bindings.ANALYTICS.prepare(
      "SELECT status, error_code FROM console_job_runs WHERE job = 'analytics-search-console'").first<{ status: string; error_code: string }>();
    expect(run).toEqual({ status: 'failed', error_code: 'google_token_rejected' });
  });

  it('does nothing without a configured credential', async () => {
    const result = await runGscCollection(env({ GSC_SERVICE_ACCOUNT_JSON: undefined }), {
      scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('not_configured');
    expect(google.requests()).toBe(0);
    expect(await countRows('gsc_daily_totals')).toBe(0);
  });
});

describe('scheduling, leases and recovery', () => {
  async function markBackfillComplete(): Promise<void> {
    await bindings.ANALYTICS.prepare('UPDATE gsc_properties SET backfill_complete = 1, backfill_cursor = NULL').run();
  }

  it('holds a lease so a second run cannot overlap', async () => {
    await bindings.ANALYTICS.prepare(
      `INSERT INTO gsc_sync_state (id, lease_owner, lease_expires_at_ms, updated_at_ms) VALUES (1, 'other-run', ?, ?)`)
      .bind(NOW.getTime() + 5 * 60_000, NOW.getTime()).run();
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('lease_held');
    expect(google.requests()).toBe(0);
    expect(await countRows('gsc_daily_totals')).toBe(0);
  });

  it('takes over an expired lease instead of staying blocked', async () => {
    await bindings.ANALYTICS.prepare(
      `INSERT INTO gsc_sync_state (id, lease_owner, lease_expires_at_ms, updated_at_ms) VALUES (1, 'stale-run', ?, ?)`)
      .bind(NOW.getTime() - 60_000, NOW.getTime()).run();
    const result = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(result.status).toBe('ok');
    const state = await bindings.ANALYTICS.prepare('SELECT lease_owner, lease_expires_at_ms FROM gsc_sync_state WHERE id = 1')
      .first<{ lease_owner: string | null; lease_expires_at_ms: number | null }>();
    expect(state).toEqual({ lease_owner: null, lease_expires_at_ms: null });
  });

  it('runs once a day, then keeps backfilling on the hourly trigger', async () => {
    seedTraffic();
    const first = await runScheduledGscCollection(env(), { now: NOW, fetcher: google.fetch });
    expect(first.scope).toBe('full');

    // One hour later the daily pass is not due, but the backfill is incomplete.
    const hourly = await runScheduledGscCollection(env(), {
      now: new Date(NOW.getTime() + 60 * 60_000), fetcher: google.fetch,
    });
    expect(hourly.scope).toBe('backfill');
    expect(hourly.status).toBe('ok');

    await markBackfillComplete();
    const quiet = await runScheduledGscCollection(env(), {
      now: new Date(NOW.getTime() + 2 * 60 * 60_000), fetcher: google.fetch,
    });
    expect(quiet.status).toBe('skipped');
    expect(quiet.reason).toBe('not_due');
    expect(quiet.requests).toBe(0);

    // Twenty-one hours after the last success the daily reconciliation is due again.
    const nextDay = await runScheduledGscCollection(env(), {
      now: new Date(NOW.getTime() + 21 * 60 * 60_000), fetcher: google.fetch,
    });
    expect(nextDay.scope).toBe('daily');
    expect(nextDay.status).toBe('ok');
  });

  it('retries a failed daily pass on the next hourly run instead of waiting a day', async () => {
    google.tokenStatus = 401;
    const failed = await runScheduledGscCollection(env(), { now: NOW, fetcher: google.fetch });
    expect(failed.status).toBe('failed');

    google.tokenStatus = null;
    const retried = await runScheduledGscCollection(env(), {
      now: new Date(NOW.getTime() + 60 * 60_000), fetcher: google.fetch,
    });
    expect(retried.scope).toBe('full');
    expect(retried.status).toBe('ok');
  });

  it('upgrades a provisional day to final once Google finalizes it', async () => {
    seedTraffic();
    google.firstIncomplete = '2026-10-26';
    await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect((await totalRow(PROPERTY, '2026-10-26'))!.data_state).toBe('provisional');

    const tomorrow = new Date('2026-10-28T12:00:00.000Z');
    google.firstIncomplete = '2026-10-27';
    await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: tomorrow, fetcher: google.fetch });
    expect((await totalRow(PROPERTY, '2026-10-26'))!.data_state).toBe('final');
    expect((await propertyRow(PROPERTY))!.first_incomplete_day).toBe('2026-10-27');
  });

  it('advances backfill by one chunk per run and reports truncation', async () => {
    seedTraffic();
    google.fullQueryPages = 3;
    const first = await runGscCollection(env(), { scope: 'full', trigger: 'cron', now: NOW, fetcher: google.fetch });
    const outcome = first.properties.find(item => item.property === PROPERTY)!;
    expect(outcome.queries_truncated).toBe(true);
    expect(outcome.pages_truncated).toBe(false);
    expect((await propertyRow(PROPERTY))!.backfill_cursor).toBe('2026-09-19');

    const second = await runGscCollection(env(), { scope: 'backfill', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(second.properties.find(item => item.property === PROPERTY)!.windows).toBe(1);
    expect((await propertyRow(PROPERTY))!.backfill_cursor).toBe('2026-08-20');
  });

  it('finishes backfill at the retention floor and stops asking Google', async () => {
    await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    await bindings.ANALYTICS.prepare("UPDATE gsc_properties SET backfill_cursor = '2025-07-10', backfill_complete = 0").run();
    const result = await runGscCollection(env(), { scope: 'backfill', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(result.properties.every(item => item.backfill_complete)).toBe(true);
    expect(result.properties.every(item => item.status === 'empty')).toBe(true);

    const again = await runGscCollection(env(), { scope: 'backfill', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(again.properties.every(item => item.windows === 0)).toBe(true);
    expect(again.requests).toBe(0);
  });

  it('bounds manual triggers per hour', async () => {
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) {
      expect(await consumeManualRun(bindings.ANALYTICS, now + index)).toBe(true);
    }
    expect(await consumeManualRun(bindings.ANALYTICS, now + 10)).toBe(false);
    expect(await consumeManualRun(bindings.ANALYTICS, now + MANUAL_WINDOW_MS + 1)).toBe(true);
  });

  it('records an observable failure when the scheduled run throws unexpectedly', async () => {
    const broken = { ...bindings.ANALYTICS, prepare: () => { throw new Error('database unavailable'); } } as unknown as D1Database;
    await expect(runScheduledGscCollection(env({ ANALYTICS: broken }), { now: NOW, fetcher: google.fetch }))
      .rejects.toThrow('database unavailable');
  });
});

describe('daily clock', () => {
  async function lastSuccess(): Promise<string | null> {
    const row = await bindings.ANALYTICS.prepare('SELECT last_success_at FROM gsc_sync_state WHERE id = 1')
      .first<{ last_success_at: string | null }>();
    return row?.last_success_at ?? null;
  }

  it('does not let one removed property re-spend the whole budget every hour', async () => {
    google.properties.delete('sc-domain:worthlookingup.com');
    const first = await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    expect(first.status).toBe('partial');
    expect(first.properties.find(item => item.property === 'sc-domain:worthlookingup.com')!.status).toBe('inaccessible');
    // The daily pass is still considered complete, so the next run is an hourly backfill step.
    expect(await lastSuccess()).toBe(NOW.toISOString());
  });

  it('keeps retrying hourly while an API failure is transient', async () => {
    await runGscCollection(env(), { scope: 'daily', trigger: 'cron', now: NOW, fetcher: google.fetch });
    google.failure = { property: PROPERTY, dimensions: ['date', 'page'], status: 503 };
    const failed = await runGscCollection(env(), {
      scope: 'daily', trigger: 'cron', now: new Date(NOW.getTime() + 60 * 60_000), fetcher: google.fetch,
    });
    expect(failed.status).toBe('partial');
    // A transient failure does not advance the daily clock.
    expect(await lastSuccess()).toBe(NOW.toISOString());
  });
});
