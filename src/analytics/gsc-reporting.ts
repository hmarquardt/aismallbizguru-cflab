// Site-scoped Search Console reporting for the dashboard's Search tab.
//
// Separation from first-party analytics is deliberate: these endpoints read only
// `gsc_*` tables, never `analytics_events` or the daily rollups, and they never
// add clicks to pageviews. Aggregates are computed from stored daily rows:
// CTR is SUM(clicks)/SUM(impressions) (never an average of daily ratios) and
// average position is weighted by impressions, which is the only aggregation
// that is arithmetically meaningful for Google's per-day averages.
//
// A stored zero row means Google reported no search traffic for that day. A date
// with no row at all means that day was never collected, and it is reported as
// `missing_days` rather than as zero traffic.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AnalyticsEnv } from './env';
import { ApiError } from '../http';
import { shiftDay, validDay } from './sanitize';
import { definitionsForSiteSlug, GSC_SEARCH_TYPE } from './gsc-properties';
import { REPORT_LAG_DAYS, daysInWindow, readSyncState } from './gsc-collector';

export const searchReports = new Hono<AnalyticsEnv>();

export interface GscPropertyView {
  property: string;
  label: string;
  hostname: string;
  permission_level: string | null;
  mapped: boolean;
  active: boolean;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  newest_day: string | null;
  first_incomplete_day: string | null;
  days_covered: number;
  backfill_cursor: string | null;
  backfill_complete: boolean;
}

interface PropertyRow {
  property: string;
  label: string;
  hostname: string;
  permission_level: string | null;
  active: number;
  backfill_cursor: string | null;
  backfill_complete: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  days_covered: number;
  newest_day: string | null;
  first_incomplete_day: string | null;
}

interface Range {
  from: string;
  to: string;
}

// The property list is the intersection of the reviewed code mapping for this
// Site and the registered rows. Before the first collection only the code
// mapping exists, and it is returned with empty state so the tab can say
// "waiting for the first synchronization" instead of failing.
async function siteProperties(db: D1Database, siteSlug: string, siteId: number): Promise<GscPropertyView[]> {
  const { results } = await db.prepare(
    `SELECT property, label, hostname, permission_level, active, backfill_cursor, backfill_complete,
            last_attempt_at, last_success_at, last_error_code, days_covered, newest_day, first_incomplete_day
     FROM gsc_properties WHERE site_id = ? ORDER BY property`).bind(siteId).all<PropertyRow>();
  const registered = new Map<string, PropertyRow>(results.map(row => [row.property, row]));
  const definitions = definitionsForSiteSlug(siteSlug);
  const views: GscPropertyView[] = [];
  for (const definition of definitions) {
    const row = registered.get(definition.property);
    const hostname = definition.property.startsWith('sc-domain:')
      ? definition.property.slice('sc-domain:'.length) : '';
    views.push({
      property: definition.property,
      label: definition.label,
      hostname: row?.hostname ?? hostname,
      permission_level: row?.permission_level ?? null,
      mapped: true,
      active: row ? !!row.active : true,
      last_attempt_at: row?.last_attempt_at ?? null,
      last_success_at: row?.last_success_at ?? null,
      last_error_code: row?.last_error_code ?? null,
      newest_day: row?.newest_day ?? null,
      first_incomplete_day: row?.first_incomplete_day ?? null,
      days_covered: Number(row?.days_covered ?? 0),
      backfill_cursor: row?.backfill_cursor ?? null,
      backfill_complete: row ? !!row.backfill_complete : false,
    });
  }
  return views;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resolveProperty(c: Context<AnalyticsEnv>) {
  const site = c.get('site');
  const properties = await siteProperties(c.env.ANALYTICS, site.slug, site.id);
  if (!properties.length) {
    throw new ApiError(404, 'search_not_mapped', 'No Search Console property is mapped to this Site');
  }
  const requested = c.req.query('property');
  if (requested !== undefined) {
    const match = properties.find(item => item.property === requested);
    if (!match) throw new ApiError(400, 'invalid_input', 'Unknown Search Console property for this Site');
    return { site, properties, property: match };
  }
  return { site, properties, property: properties[0]! };
}

function range(c: Context<AnalyticsEnv>): Range {
  const latest = shiftDay(today(), -REPORT_LAG_DAYS);
  const to = c.req.query('to') ?? latest;
  const from = c.req.query('from') ?? shiftDay(to, -29);
  if (!validDay(from) || !validDay(to) || from > to) throw new ApiError(400, 'invalid_input', 'Invalid date range');
  const days = daysInWindow({ from, to }).length;
  if (days > 480) throw new ApiError(400, 'invalid_input', 'Date range exceeds the Search Console retention window');
  return { from, to };
}

function limitParam(value: string | undefined, fallback = 20): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new ApiError(400, 'invalid_input', 'Invalid limit');
  return parsed;
}

interface TotalsRow {
  clicks: number;
  impressions: number;
  weighted_position: number | null;
  positioned_impressions: number | null;
  days: number;
  provisional_days: number;
}

function totalsOutput(row: TotalsRow | null) {
  const clicks = Number(row?.clicks ?? 0);
  const impressions = Number(row?.impressions ?? 0);
  const positioned = Number(row?.positioned_impressions ?? 0);
  const weighted = Number(row?.weighted_position ?? 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: positioned > 0 ? weighted / positioned : null,
    days: Number(row?.days ?? 0),
    provisional_days: Number(row?.provisional_days ?? 0),
  };
}

const TOTALS_SQL = `SELECT COALESCE(SUM(clicks), 0) AS clicks,
       COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE position * impressions END), 0) AS weighted_position,
       COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE impressions END), 0) AS positioned_impressions,
       COUNT(*) AS days,
       COALESCE(SUM(CASE WHEN data_state = 'provisional' THEN 1 ELSE 0 END), 0) AS provisional_days
  FROM gsc_daily_totals WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?`;

export async function searchStatus(db: D1Database, siteSlug: string, siteId: number, configured: boolean) {
  const properties = await siteProperties(db, siteSlug, siteId);
  const sync = await readSyncState(db);
  const latest = shiftDay(today(), -REPORT_LAG_DAYS);
  const newest = properties.reduce<string | null>((max, item) =>
    item.newest_day && (!max || item.newest_day > max) ? item.newest_day : max, null);
  const marker = properties.reduce<string | null>((earliest, item) =>
    item.first_incomplete_day && (!earliest || item.first_incomplete_day < earliest) ? item.first_incomplete_day : earliest, null);
  return {
    configured,
    properties,
    sync: {
      last_attempt_at: sync?.last_run_started_at ?? null,
      last_finished_at: sync?.last_run_finished_at ?? null,
      last_success_at: sync?.last_success_at ?? null,
      last_error_code: sync?.last_error_code ?? null,
    },
    freshness: {
      newest_reportable_day: latest,
      newest_day: newest,
      data_state: newest === null ? 'none'
        : (marker !== null ? newest >= marker : newest >= latest) ? 'provisional' : 'final',
      lag_days: newest === null ? null : daysInWindow({ from: newest, to: latest }).length - 1,
    },
  };
}

async function propertyFreshness(db: D1Database, property: string, from: string, to: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS covered_days, MAX(report_day) AS newest_day,
            COALESCE(SUM(CASE WHEN data_state = 'provisional' THEN 1 ELSE 0 END), 0) AS provisional_days
     FROM gsc_daily_totals WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?`)
    .bind(property, GSC_SEARCH_TYPE, from, to)
    .first<{ covered_days: number; newest_day: string | null; provisional_days: number }>();
  const requested = daysInWindow({ from, to }).length;
  const covered = Number(row?.covered_days ?? 0);
  return {
    covered_days: covered,
    requested_days: requested,
    missing_days: Math.max(0, requested - covered),
    newest_day: row?.newest_day ?? null,
    provisional_days: Number(row?.provisional_days ?? 0),
  };
}

searchReports.get('/search/status', async c => {
  const site = c.get('site');
  return c.json({
    site: site.public_id,
    ...(await searchStatus(c.env.ANALYTICS, site.slug, site.id, Boolean(c.env.GSC_SERVICE_ACCOUNT_JSON))),
  });
});

searchReports.get('/search/summary', async c => {
  const { site, property } = await resolveProperty(c);
  const { from, to } = range(c);
  const db = c.env.ANALYTICS;
  const current = await db.prepare(TOTALS_SQL).bind(property.property, GSC_SEARCH_TYPE, from, to).first<TotalsRow>();
  const days = daysInWindow({ from, to }).length;
  const previousTo = shiftDay(from, -1);
  const previousFrom = shiftDay(previousTo, -(days - 1));
  const previous = await db.prepare(TOTALS_SQL)
    .bind(property.property, GSC_SEARCH_TYPE, previousFrom, previousTo).first<TotalsRow>();
  return c.json({
    site: site.public_id,
    property: property.property,
    property_label: property.label,
    search_type: GSC_SEARCH_TYPE,
    from,
    to,
    totals: totalsOutput(current),
    previous: { from: previousFrom, to: previousTo, ...totalsOutput(previous) },
    freshness: {
      ...(await propertyFreshness(db, property.property, from, to)),
      last_success_at: property.last_success_at,
      first_incomplete_day: property.first_incomplete_day,
      last_error_code: property.last_error_code,
    },
  });
});

searchReports.get('/search/timeseries', async c => {
  const { site, property } = await resolveProperty(c);
  const { from, to } = range(c);
  const { results } = await c.env.ANALYTICS.prepare(
    `SELECT report_day AS date, clicks, impressions, ctr, position, data_state
     FROM gsc_daily_totals WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?
     ORDER BY report_day`)
    .bind(property.property, GSC_SEARCH_TYPE, from, to)
    .all<{ date: string; clicks: number; impressions: number; ctr: number; position: number | null; data_state: string }>();
  return c.json({
    site: site.public_id, property: property.property, search_type: GSC_SEARCH_TYPE, from, to,
    points: results.map(row => ({
      date: row.date, clicks: Number(row.clicks), impressions: Number(row.impressions),
      ctr: Number(row.ctr), position: row.position === null ? null : Number(row.position),
      data_state: row.data_state,
    })),
  });
});

interface AggregateRow {
  value: string;
  clicks: number;
  impressions: number;
  weighted_position: number | null;
  positioned_impressions: number | null;
  days: number;
}

const AGGREGATE_SQL = (table: string, column: string) => `SELECT ${column} AS value,
       COALESCE(SUM(clicks), 0) AS clicks,
       COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE position * impressions END), 0) AS weighted_position,
       COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE impressions END), 0) AS positioned_impressions,
       COUNT(*) AS days
  FROM ${table} WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?
  GROUP BY ${column} ORDER BY clicks DESC, impressions DESC, ${column} ASC LIMIT ?`;

export function aggregateOutput(rows: AggregateRow[]) {
  return rows.map(row => {
    const impressions = Number(row.impressions);
    const positioned = Number(row.positioned_impressions ?? 0);
    return {
      value: row.value,
      clicks: Number(row.clicks),
      impressions,
      ctr: impressions > 0 ? Number(row.clicks) / impressions : 0,
      position: positioned > 0 ? Number(row.weighted_position ?? 0) / positioned : null,
      days: Number(row.days),
    };
  });
}

// Renames the generic `value` key so each response says what the rows describe
// (a query, a landing page, a device) without losing the shared aggregate shape.
function keyed(rows: ReturnType<typeof aggregateOutput>, key: 'query' | 'page' | 'value') {
  return rows.map(row => ({
    [key]: row.value,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
    days: row.days,
  }));
}

searchReports.get('/search/queries', async c => {
  const { site, property } = await resolveProperty(c);
  const { from, to } = range(c);
  const limit = limitParam(c.req.query('limit'));
  const { results } = await c.env.ANALYTICS.prepare(AGGREGATE_SQL('gsc_query_daily', 'query_text'))
    .bind(property.property, GSC_SEARCH_TYPE, from, to, limit).all<AggregateRow>();
  return c.json({
    site: site.public_id, property: property.property, search_type: GSC_SEARCH_TYPE, from, to,
    queries: keyed(aggregateOutput(results), 'query'),
  });
});

searchReports.get('/search/pages', async c => {
  const { site, property } = await resolveProperty(c);
  const { from, to } = range(c);
  const limit = limitParam(c.req.query('limit'));
  const { results } = await c.env.ANALYTICS.prepare(AGGREGATE_SQL('gsc_page_daily', 'page_url'))
    .bind(property.property, GSC_SEARCH_TYPE, from, to, limit).all<AggregateRow>();
  return c.json({
    site: site.public_id, property: property.property, search_type: GSC_SEARCH_TYPE, from, to,
    pages: keyed(aggregateOutput(results), 'page'),
  });
});

searchReports.get('/search/breakdowns', async c => {
  const { site, property } = await resolveProperty(c);
  const { from, to } = range(c);
  const limit = limitParam(c.req.query('limit'), 10);
  const db = c.env.ANALYTICS;
  // One query per dimension so a crowded device list cannot starve countries.
  const dimensionQuery = (dimension: 'device' | 'country') => db.prepare(
    `SELECT value,
            COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(impressions), 0) AS impressions,
            COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE position * impressions END), 0) AS weighted_position,
            COALESCE(SUM(CASE WHEN position IS NULL THEN 0 ELSE impressions END), 0) AS positioned_impressions,
            COUNT(*) AS days
     FROM gsc_breakdown_daily
     WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ? AND dimension = ?
     GROUP BY value ORDER BY impressions DESC, clicks DESC, value ASC LIMIT ?`)
    .bind(property.property, GSC_SEARCH_TYPE, from, to, dimension, limit);
  const [devices, countries] = await Promise.all([
    dimensionQuery('device').all<AggregateRow>(),
    dimensionQuery('country').all<AggregateRow>(),
  ]);
  return c.json({
    site: site.public_id, property: property.property, search_type: GSC_SEARCH_TYPE, from, to,
    devices: keyed(aggregateOutput(devices.results), 'value'),
    countries: keyed(aggregateOutput(countries.results), 'value'),
  });
});
