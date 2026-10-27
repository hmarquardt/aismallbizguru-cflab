// Scheduled Google Search Console collection.
//
// Guarantees this module is responsible for:
//   * one atomic lease per run, so an hourly cron and a manual trigger can never
//     collect at the same time;
//   * a daily pass that reconciles the last RECONCILE_DAYS reportable days (which
//     is what turns a provisional day into a final one), plus a bounded
//     historical backfill that advances one chunk per run until it reaches
//     Google's retention floor;
//   * every write is window-scoped and atomic: a re-run replaces the same window
//     instead of appending, so counts never double and a corrected row replaces
//     a stale one;
//   * an empty Google response is `empty`, not a failure: days with no search
//     traffic are stored as zeros so "collected, reported nothing" is distinct
//     from "never collected" (no row);
//   * authentication, access, API, and write failures stay distinguishable;
//   * the number of Google requests, pages and elapsed time per run is bounded.

import type { AnalyticsBindings } from './env';
import { GSC_PROPERTIES, GSC_SEARCH_TYPE, parseProperty, type GscPropertyDefinition } from './gsc-properties';
import { GscClient, errorCode, ROW_LIMIT, type GscSite, type SearchAnalyticsRow, type SearchAnalyticsResult } from './gsc-client';
import { shiftDay, validDay } from './sanitize';

export const JOB_ID = 'analytics-search-console';
export const REPORT_LAG_DAYS = 1;
export const RECONCILE_DAYS = 7;
export const BACKFILL_CHUNK_DAYS = 30;
/** Google publishes roughly sixteen months of Search Analytics history. */
export const RETENTION_DAYS = 480;
export const FALLBACK_FINALIZE_LAG_DAYS = 3;
export const DAILY_MIN_INTERVAL_HOURS = 20;
export const LEASE_TTL_MINUTES = 10;
export const MAX_REQUESTS_PER_RUN = 180;
export const MAX_MANUAL_RUNS_PER_HOUR = 4;
export const MANUAL_WINDOW_MS = 3_600_000;
export const MAX_RUN_MS = 240_000;
export const MAX_KEY_LENGTH = 512;
/** D1 rejects a statement with too many bound parameters; stay well under it. */
const MAX_BOUND_PARAMS = 90;

export type GscScope = 'daily' | 'backfill' | 'full';
export type GscTrigger = 'cron' | 'manual';
export type GscRunStatus = 'ok' | 'partial' | 'failed' | 'skipped';
export type GscPropertyStatus = 'ok' | 'empty' | 'failed' | 'inaccessible' | 'deferred';

export interface Window {
  from: string;
  to: string;
}

export interface GscPropertyOutcome {
  property: string;
  site_slug: string | null;
  status: GscPropertyStatus;
  permission_level: string | null;
  windows: number;
  days: number;
  totals_rows: number;
  query_rows: number;
  page_rows: number;
  breakdown_rows: number;
  queries_truncated: boolean;
  pages_truncated: boolean;
  requests: number;
  rejected_rows: number;
  duration_ms: number;
  backfill_complete: boolean;
  error_code?: string;
}

export interface GscRunResult {
  status: GscRunStatus;
  scope: GscScope | null;
  trigger: GscTrigger;
  run_id: string | null;
  reason?: string;
  properties: GscPropertyOutcome[];
  requests: number;
  days_collected: number;
  duration_ms: number;
}

export interface CollectionOptions {
  scope: GscScope;
  trigger: GscTrigger;
  userId?: string;
  fetcher?: typeof fetch;
  now?: Date;
}

interface PropertyStateRow {
  property: string;
  site_id: number | null;
  backfill_cursor: string | null;
  backfill_complete: number;
  last_success_at: string | null;
  newest_day: string | null;
  first_incomplete_day: string | null;
}

interface SyncStateRow {
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
}

/* Planning -------------------------------------------------------------------- */

// The newest day the collector may request and the oldest day Google still
// publishes. Today is never requested: Google has not finished collecting it.
export function reportableRange(today: string): { newest: string; floor: string } {
  return { newest: shiftDay(today, -REPORT_LAG_DAYS), floor: shiftDay(today, -RETENTION_DAYS) };
}

export function reconcileWindow(newest: string, floor: string): Window {
  const from = shiftDay(newest, -(RECONCILE_DAYS - 1));
  return { from: from < floor ? floor : from, to: newest };
}

// One bounded backfill chunk ending immediately before the reconcile window (or
// before the previous chunk). The cursor never moves past the retention floor,
// and a null cursor starts after the reconciled days.
export function backfillWindow(
  cursor: string | null, newest: string, floor: string, chunkDays = BACKFILL_CHUNK_DAYS,
): { window: Window | null; nextCursor: string | null; complete: boolean } {
  const start = cursor ?? shiftDay(newest, -RECONCILE_DAYS);
  if (start < floor) return { window: null, nextCursor: null, complete: true };
  if (!validDay(start)) return { window: null, nextCursor: null, complete: false };
  const from = shiftDay(start, -(chunkDays - 1));
  const window: Window = { from: from < floor ? floor : from, to: start };
  if (window.from > window.to) return { window: null, nextCursor: null, complete: true };
  const nextCursor = shiftDay(window.from, -1);
  return { window, nextCursor, complete: nextCursor < floor };
}

// Sorted, merged, non-overlapping windows. Merging keeps one report request per
// contiguous range instead of querying the same days twice.
export function mergeWindows(windows: Window[]): Window[] {
  const ordered = windows
    .filter(window => validDay(window.from) && validDay(window.to) && window.from <= window.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged: Window[] = [];
  for (const window of ordered) {
    const last = merged[merged.length - 1];
    if (last && shiftDay(last.to, 1) >= window.from) {
      last.to = last.to > window.to ? last.to : window.to;
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

// Google's own `first_incomplete_date` is authoritative. Only when Google omits
// it (for example a pinned older response) does the documented 2-3 day
// processing delay decide.
export function dataStateFor(day: string, firstIncomplete: string | null, today: string): 'final' | 'provisional' {
  if (firstIncomplete && validDay(firstIncomplete)) return day >= firstIncomplete ? 'provisional' : 'final';
  return day > shiftDay(today, -FALLBACK_FINALIZE_LAG_DAYS) ? 'provisional' : 'final';
}

export function daysInWindow(window: Window): string[] {
  const days: string[] = [];
  let day = window.from;
  for (let guard = 0; guard <= RETENTION_DAYS + 2; guard += 1) {
    if (day > window.to) break;
    days.push(day);
    day = shiftDay(day, 1);
  }
  return days;
}

// One dimension value as it will be stored. Control characters would break the
// dashboard's text rendering, and an unbounded value is a payload rather than a
// dimension key, so both are rejected instead of coerced.
export function cleanKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_KEY_LENGTH ? cleaned.slice(0, MAX_KEY_LENGTH) : cleaned;
}

/* Persistence ---------------------------------------------------------------- */

type DetailTable = 'gsc_query_daily' | 'gsc_page_daily';

function placeholders(columns: number, rows: number): string {
  return Array.from({ length: rows }, () => `(${Array.from({ length: columns }, () => '?').join(', ')})`).join(', ');
}

// Splits rows so one INSERT never binds more parameters than D1 accepts.
export function chunkRows<T>(rows: T[], columns: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

export async function readSyncState(db: D1Database): Promise<SyncStateRow | null> {
  return await db.prepare(
    `SELECT lease_owner, lease_expires_at_ms, last_run_started_at, last_run_finished_at, last_success_at, last_error_code
     FROM gsc_sync_state WHERE id = 1`).first<SyncStateRow>();
}

export async function readPropertyStates(db: D1Database): Promise<Map<string, PropertyStateRow>> {
  const { results } = await db.prepare(
    'SELECT property, site_id, backfill_cursor, backfill_complete, last_success_at, newest_day, first_incomplete_day FROM gsc_properties')
    .all<PropertyStateRow>();
  return new Map(results.map(row => [row.property, row]));
}

// A lease is the only guard against two collections running at once. It is taken
// with one conditional upsert: replacing an expired or same-owner lease is the
// only way `changes` can be 1.
async function acquireLease(db: D1Database, owner: string, nowMs: number): Promise<boolean> {
  const expires = nowMs + LEASE_TTL_MINUTES * 60_000;
  const result = await db.prepare(
    `INSERT INTO gsc_sync_state (id, lease_owner, lease_expires_at_ms, updated_at_ms) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lease_owner = excluded.lease_owner,
       lease_expires_at_ms = excluded.lease_expires_at_ms, updated_at_ms = excluded.updated_at_ms
     WHERE gsc_sync_state.lease_expires_at_ms IS NULL
        OR gsc_sync_state.lease_expires_at_ms <= ?
        OR gsc_sync_state.lease_owner = ?`)
    .bind(owner, expires, nowMs, nowMs, owner).run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function releaseLease(db: D1Database, owner: string, nowMs: number): Promise<void> {
  await db.prepare(
    'UPDATE gsc_sync_state SET lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ? WHERE id = 1 AND lease_owner = ?')
    .bind(nowMs, owner).run();
}

// Counts one manual trigger and fails closed when the hourly budget is spent.
export async function consumeManualRun(db: D1Database, nowMs: number): Promise<boolean> {
  await db.prepare(
    `INSERT INTO gsc_sync_state (id, manual_window_start_ms, manual_runs_in_window, updated_at_ms)
     VALUES (1, 0, 0, ?) ON CONFLICT(id) DO NOTHING`).bind(nowMs).run();
  const result = await db.prepare(
    `UPDATE gsc_sync_state
     SET manual_window_start_ms = CASE WHEN manual_window_start_ms <= ? THEN ? ELSE manual_window_start_ms END,
         manual_runs_in_window = CASE WHEN manual_window_start_ms <= ? THEN 1 ELSE manual_runs_in_window + 1 END,
         updated_at_ms = ?
     WHERE id = 1 AND (manual_window_start_ms <= ? OR manual_runs_in_window < ?)`)
    .bind(nowMs - MANUAL_WINDOW_MS, nowMs, nowMs - MANUAL_WINDOW_MS, nowMs, nowMs - MANUAL_WINDOW_MS, MAX_MANUAL_RUNS_PER_HOUR)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function siteIdBySlug(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare('SELECT id, slug FROM analytics_sites').all<{ id: number; slug: string }>();
  return new Map(results.map(row => [row.slug, Number(row.id)]));
}

// Registers the property before any data is fetched, so a property that is
// accessible but has no traffic yet is still visible and observable.
export async function upsertProperty(
  db: D1Database, definition: GscPropertyDefinition, siteId: number | null, permissionLevel: string | null, nowMs: number,
): Promise<void> {
  const parsed = parseProperty(definition.property);
  if (!parsed) return;
  await db.prepare(
    `INSERT INTO gsc_properties
       (property, property_kind, hostname, label, site_id, permission_level, active, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(property) DO UPDATE SET property_kind = excluded.property_kind, hostname = excluded.hostname,
       label = excluded.label, site_id = excluded.site_id, permission_level = excluded.permission_level,
       active = 1, updated_at_ms = excluded.updated_at_ms`)
    .bind(definition.property, parsed.kind, parsed.hostname, definition.label, siteId, permissionLevel, nowMs, nowMs)
    .run();
}

function rowsByDay(result: SearchAnalyticsResult, window: Window): Map<string, SearchAnalyticsRow> {
  const byDay = new Map<string, SearchAnalyticsRow>();
  for (const row of result.rows) {
    const day = row.keys[0];
    if (!day || !validDay(day) || day < window.from || day > window.to) continue;
    const existing = byDay.get(day);
    if (!existing || row.impressions > existing.impressions) byDay.set(day, row);
  }
  return byDay;
}

// Replaces the totals for an entire window. Days Google omitted are stored as
// zeros: that is a reported zero, not a missing collection, and it lets the
// dashboard say "no search traffic reported" instead of "no data".
export async function writeDailyTotals(
  db: D1Database, property: string, window: Window, result: SearchAnalyticsResult, today: string, nowMs: number,
): Promise<number> {
  const byDay = rowsByDay(result, window);
  const days = daysInWindow(window);
  if (!days.length) return 0;
  const rows: (string | number | null)[][] = [];
  for (const day of days) {
    const row = byDay.get(day);
    rows.push([
      property, GSC_SEARCH_TYPE, day,
      row?.clicks ?? 0, row?.impressions ?? 0, row?.ctr ?? 0, row?.position ?? null,
      dataStateFor(day, result.first_incomplete_date, today), nowMs,
    ]);
  }
  const statements = [db.prepare(
    'DELETE FROM gsc_daily_totals WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?')
    .bind(property, GSC_SEARCH_TYPE, window.from, window.to)];
  for (const chunk of chunkRows(rows, 9)) {
    statements.push(db.prepare(
      `INSERT INTO gsc_daily_totals
         (property, search_type, report_day, clicks, impressions, ctr, position, data_state, collected_at_ms)
       VALUES ${placeholders(9, chunk.length)}`).bind(...chunk.flat()));
  }
  await db.batch(statements);
  return days.length;
}

interface DetailEntry {
  day: string;
  value: string;
  row: SearchAnalyticsRow;
}

function detailEntries(result: SearchAnalyticsResult, window: Window): DetailEntry[] {
  const entries = new Map<string, DetailEntry>();
  for (const row of result.rows) {
    const day = row.keys[0];
    const value = cleanKey(row.keys[1]);
    if (!day || !validDay(day) || day < window.from || day > window.to || !value) continue;
    const key = `${day}\u0000${value}`;
    const existing = entries.get(key);
    if (!existing || row.clicks > existing.row.clicks) entries.set(key, { day, value, row });
  }
  return [...entries.values()];
}

// Replaces the whole window for a detail report. A query or page that dropped
// out of Google's top rows must not survive as a stale row, so the window is
// replaced atomically rather than upserted row by row.
export async function writeDetailRows(
  db: D1Database, table: DetailTable, property: string, window: Window, result: SearchAnalyticsResult, nowMs: number,
): Promise<number> {
  const valueColumn = table === 'gsc_query_daily' ? 'query_text' : 'page_url';
  const entries = detailEntries(result, window);
  const statements = [db.prepare(
    `DELETE FROM ${table} WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ?`)
    .bind(property, GSC_SEARCH_TYPE, window.from, window.to)];
  const rows: (string | number | null)[][] = entries.map(entry => [
    property, GSC_SEARCH_TYPE, entry.day, entry.value,
    entry.row.clicks, entry.row.impressions, entry.row.ctr, entry.row.position, nowMs,
  ]);
  for (const chunk of chunkRows(rows, 9)) {
    statements.push(db.prepare(
      `INSERT INTO ${table} (property, search_type, report_day, ${valueColumn}, clicks, impressions, ctr, position, collected_at_ms)
       VALUES ${placeholders(9, chunk.length)}`).bind(...chunk.flat()));
  }
  await db.batch(statements);
  return entries.length;
}

export async function writeBreakdownRows(
  db: D1Database, property: string, window: Window,
  devices: SearchAnalyticsResult, countries: SearchAnalyticsResult, nowMs: number,
): Promise<number> {
  const statements = [db.prepare(
    `DELETE FROM gsc_breakdown_daily
     WHERE property = ? AND search_type = ? AND report_day >= ? AND report_day <= ? AND dimension IN ('device', 'country')`)
    .bind(property, GSC_SEARCH_TYPE, window.from, window.to)];
  const rows: (string | number | null)[][] = [];
  let inserted = 0;
  for (const [dimension, result] of [['device', devices], ['country', countries]] as const) {
    for (const entry of detailEntries(result, window)) {
      rows.push([
        property, GSC_SEARCH_TYPE, entry.day, dimension, entry.value,
        entry.row.clicks, entry.row.impressions, entry.row.ctr, entry.row.position, nowMs,
      ]);
      inserted += 1;
    }
  }
  for (const chunk of chunkRows(rows, 10)) {
    statements.push(db.prepare(
      `INSERT INTO gsc_breakdown_daily
         (property, search_type, report_day, dimension, value, clicks, impressions, ctr, position, collected_at_ms)
       VALUES ${placeholders(10, chunk.length)}`).bind(...chunk.flat()));
  }
  await db.batch(statements);
  return inserted;
}

async function propertyCoverage(db: D1Database, property: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS days FROM gsc_daily_totals WHERE property = ? AND search_type = ?')
    .bind(property, GSC_SEARCH_TYPE).first<{ days: number }>();
  return Number(row?.days ?? 0);
}

async function markPropertyFailure(
  db: D1Database, property: string, permissionLevel: string | null, errorCodeValue: string, nowMs: number,
): Promise<void> {
  await db.prepare(
    `UPDATE gsc_properties SET permission_level = ?, last_attempt_at = ?, last_error_code = ?, updated_at_ms = ?
     WHERE property = ?`)
    .bind(permissionLevel, new Date(nowMs).toISOString(), errorCodeValue, nowMs, property).run();
}

async function markPropertySuccess(
  db: D1Database,
  property: string,
  values: {
    permissionLevel: string | null;
    newestDay: string | null;
    firstIncompleteDay: string | null;
    backfillCursor: string | null;
    backfillComplete: boolean;
  },
  nowMs: number,
): Promise<void> {
  const days = await propertyCoverage(db, property);
  const at = new Date(nowMs).toISOString();
  await db.prepare(
    `UPDATE gsc_properties
     SET permission_level = ?, last_attempt_at = ?, last_success_at = ?, last_error_code = NULL,
         days_covered = ?, newest_day = ?, first_incomplete_day = ?, backfill_cursor = ?,
         backfill_complete = ?, updated_at_ms = ?
     WHERE property = ?`)
    .bind(values.permissionLevel, at, at, days, values.newestDay, values.firstIncompleteDay,
      values.backfillCursor, values.backfillComplete ? 1 : 0, nowMs, property)
    .run();
}

// One console_job_runs row per run. The operations console already reads this
// table for `analytics-maintenance`; history is best effort and never changes the
// run verdict.
async function recordRun(
  db: D1Database, startedAt: string, finishedAt: string, status: 'ok' | 'failed',
  summary: Record<string, unknown>, errorCodeValue: string | null,
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db.prepare(
      `INSERT INTO console_job_runs (id, job, started_at, finished_at, status, summary_json, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, JOB_ID, startedAt, finishedAt, status, JSON.stringify(summary), errorCodeValue).run();
    return id;
  } catch {
    console.error(JSON.stringify({ event: 'gsc_run_history_write_failed', status }));
    return null;
  }
}

async function finishSyncState(
  db: D1Database,
  values: { startedAt: string; finishedAt: string; lastSuccessAt: string | null; errorCode: string | null },
  nowMs: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO gsc_sync_state (id, last_run_started_at, last_run_finished_at, last_success_at, last_error_code, updated_at_ms)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_started_at = excluded.last_run_started_at,
       last_run_finished_at = excluded.last_run_finished_at, last_success_at = excluded.last_success_at,
       last_error_code = excluded.last_error_code, updated_at_ms = excluded.updated_at_ms`)
    .bind(values.startedAt, values.finishedAt, values.lastSuccessAt, values.errorCode, nowMs).run();
}

interface FetchedWindow {
  totals: SearchAnalyticsResult;
  queries: SearchAnalyticsResult;
  pages: SearchAnalyticsResult;
  devices: SearchAnalyticsResult;
  countries: SearchAnalyticsResult;
  requests: number;
  rejected: number;
}

// All five reports are fetched before anything is written, so a window is either
// stored completely or not at all. Totals use [date] only; queries and pages use
// [date, query] / [date, page] and are explicitly bounded top-N reports.
async function fetchWindow(client: GscClient, property: string, window: Window): Promise<FetchedWindow> {
  const base = { startDate: window.from, endDate: window.to, dataState: 'all' as const };
  const totals = await client.query(property, { ...base, dimensions: ['date'], rowLimit: ROW_LIMIT });
  const queries = await client.query(property, { ...base, dimensions: ['date', 'query'], rowLimit: ROW_LIMIT });
  const pages = await client.query(property, { ...base, dimensions: ['date', 'page'], rowLimit: ROW_LIMIT });
  const devices = await client.query(property, { ...base, dimensions: ['date', 'device'], rowLimit: ROW_LIMIT });
  const countries = await client.query(property, { ...base, dimensions: ['date', 'country'], rowLimit: ROW_LIMIT });
  return {
    totals, queries, pages, devices, countries,
    requests: totals.requests + queries.requests + pages.requests + devices.requests + countries.requests,
    rejected: totals.rejected_rows + queries.rejected_rows + pages.rejected_rows +
      devices.rejected_rows + countries.rejected_rows,
  };
}

export async function runGscCollection(env: AnalyticsBindings, options: CollectionOptions): Promise<GscRunResult> {
  const now = options.now ?? new Date();
  const startedMs = Date.now();
  const nowMs = now.getTime();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);
  const db = env.ANALYTICS;
  const empty: GscRunResult = {
    status: 'skipped', scope: options.scope, trigger: options.trigger, run_id: null,
    properties: [], requests: 0, days_collected: 0, duration_ms: 0,
  };

  const credential = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!credential) return { ...empty, status: 'failed', reason: 'not_configured' };

  const owner = `gsc:${crypto.randomUUID()}`;
  if (!(await acquireLease(db, owner, nowMs))) {
    return { ...empty, reason: 'lease_held', duration_ms: Date.now() - startedMs };
  }

  const outcomes: GscPropertyOutcome[] = [];
  let requests = 0;
  let daysCollected = 0;
  let deferred = false;
  let discoveryError: string | null = null;

  try {
    const priorState = await readSyncState(db);
    const propertyStates = await readPropertyStates(db);
    const slugs = await siteIdBySlug(db);
    const { newest, floor } = reportableRange(today);
    const client = new GscClient(credential, options.fetcher ?? fetch);

    let permissions = new Map<string, string>();
    try {
      const sites: GscSite[] = await client.listProperties();
      permissions = new Map(sites.map(site => [site.siteUrl, site.permissionLevel]));
    } catch (error) {
      // Discovery failure is a run-level authentication/access problem: every
      // property is reported as inaccessible with the same reason, never empty.
      discoveryError = errorCode(error);
    }

    for (const definition of GSC_PROPERTIES) {
      const parsed = parseProperty(definition.property);
      if (!parsed) continue;
      const state = propertyStates.get(definition.property) ?? null;
      const permission = permissions.get(definition.property) ?? null;
      const siteId = definition.siteSlug ? slugs.get(definition.siteSlug) ?? null : null;
      const outcome: GscPropertyOutcome = {
        property: definition.property,
        site_slug: definition.siteSlug,
        status: 'ok',
        permission_level: permission,
        windows: 0, days: 0, totals_rows: 0, query_rows: 0, page_rows: 0, breakdown_rows: 0,
        queries_truncated: false, pages_truncated: false, requests: 0, rejected_rows: 0,
        duration_ms: 0, backfill_complete: state?.backfill_complete === 1,
      };
      const propertyStarted = Date.now();
      try {
        await upsertProperty(db, definition, siteId, permission, nowMs);
      } catch {
        outcome.status = 'failed';
        outcome.error_code = 'storage_failed';
        outcomes.push(outcome);
        continue;
      }

      if (discoveryError) {
        outcome.status = 'inaccessible';
        outcome.error_code = discoveryError;
        await markPropertyFailure(db, definition.property, null, discoveryError, nowMs).catch(() => {});
        outcomes.push(outcome);
        continue;
      }
      if (!permission) {
        outcome.status = 'inaccessible';
        outcome.error_code = 'property_not_accessible';
        await markPropertyFailure(db, definition.property, null, 'property_not_accessible', nowMs).catch(() => {});
        outcomes.push(outcome);
        continue;
      }
      if (deferred) {
        outcome.status = 'deferred';
        outcomes.push(outcome);
        continue;
      }

      const windows: Window[] = [];
      if (options.scope === 'daily' || options.scope === 'full') windows.push(reconcileWindow(newest, floor));
      const backfill = options.scope === 'backfill' || options.scope === 'full'
        ? backfillWindow(state?.backfill_cursor ?? null, newest, floor)
        : { window: null, nextCursor: null, complete: outcome.backfill_complete };
      if (backfill.window) windows.push(backfill.window);
      const planned = mergeWindows(windows);

      let failed = false;
      let firstIncomplete: string | null = null;
      let lastWindow: Window | null = null;
      let trafficReported = false;

      for (const window of planned) {
        if (requests >= MAX_REQUESTS_PER_RUN || Date.now() - startedMs > MAX_RUN_MS) { deferred = true; break; }
        try {
          const fetched = await fetchWindow(client, definition.property, window);
          const collectedAt = nowMs;
          requests += fetched.requests;
          outcome.requests += fetched.requests;
          outcome.rejected_rows += fetched.rejected;
          await writeDailyTotals(db, definition.property, window, fetched.totals, today, collectedAt);
          outcome.totals_rows += daysInWindow(window).length;
          outcome.query_rows += await writeDetailRows(db, 'gsc_query_daily', definition.property, window, fetched.queries, collectedAt);
          outcome.page_rows += await writeDetailRows(db, 'gsc_page_daily', definition.property, window, fetched.pages, collectedAt);
          outcome.breakdown_rows += await writeBreakdownRows(
            db, definition.property, window, fetched.devices, fetched.countries, collectedAt);
          if (fetched.queries.truncated) outcome.queries_truncated = true;
          if (fetched.pages.truncated) outcome.pages_truncated = true;
          if (fetched.totals.first_incomplete_date) firstIncomplete = fetched.totals.first_incomplete_date;
          if (fetched.totals.rows.some(row => row.impressions > 0)) trafficReported = true;
          outcome.windows += 1;
          outcome.days += daysInWindow(window).length;
          daysCollected += daysInWindow(window).length;
          lastWindow = window;
        } catch (error) {
          failed = true;
          outcome.error_code = errorCode(error);
          break;
        }
      }

      const allWindowsCollected = !failed && outcome.windows === planned.length;
      const backfillCursor = allWindowsCollected ? backfill.nextCursor : (state?.backfill_cursor ?? null);
      const backfillComplete = allWindowsCollected ? backfill.complete : outcome.backfill_complete;
      const newestDay = lastWindow && (!state?.newest_day || lastWindow.to > state.newest_day)
        ? lastWindow.to : (state?.newest_day ?? null);

      if (failed) {
        outcome.status = 'failed';
        await markPropertyFailure(db, definition.property, permission, outcome.error_code ?? 'upstream_error', nowMs)
          .catch(() => {});
      } else if (outcome.windows > 0) {
        outcome.status = trafficReported ? 'ok' : 'empty';
        await markPropertySuccess(db, definition.property, {
          permissionLevel: permission,
          newestDay,
          firstIncompleteDay: firstIncomplete ?? state?.first_incomplete_day ?? null,
          backfillCursor,
          backfillComplete,
        }, nowMs).catch(() => {});
        outcome.backfill_complete = backfillComplete;
      } else if (planned.length === 0) {
        // No window was due for this property (a complete backfill): report it as
        // successful and leave its stored state untouched.
        outcome.status = 'ok';
      } else {
        outcome.status = 'deferred';
        outcome.backfill_complete = backfillComplete;
      }
      outcome.duration_ms = Date.now() - propertyStarted;
      outcomes.push(outcome);
    }

    const failures = outcomes.filter(outcome => outcome.status === 'failed' || outcome.status === 'inaccessible').length;
    const successes = outcomes.filter(outcome => outcome.status === 'ok' || outcome.status === 'empty').length;
    const status: GscRunStatus = failures === 0 && !deferred ? 'ok' : successes > 0 ? 'partial' : 'failed';
    // A transient API/network/storage failure retries on the next hourly run. A
    // property that Google no longer lists is a configuration state that will not
    // fix itself within the hour, so it is recorded but does not hold the daily
    // clock hostage and re-spend the whole property budget every hour.
    const transientFailure = outcomes.some(outcome => outcome.status === 'failed');
    const dailyComplete = !transientFailure && !deferred && discoveryError === null && successes > 0;
    const finishedAt = now.toISOString();
    const errorCodeValue = discoveryError ?? outcomes.find(outcome => outcome.error_code)?.error_code ?? null;
    const lastSuccessAt = dailyComplete ? finishedAt : (priorState?.last_success_at ?? null);

    const runId = await recordRun(db, startedAt, finishedAt, dailyComplete ? 'ok' : 'failed', {
      scope: options.scope,
      trigger: options.trigger,
      status,
      requests,
      days: daysCollected,
      properties: outcomes.map(outcome => ({
        property: outcome.property,
        status: outcome.status,
        windows: outcome.windows,
        days: outcome.days,
        totals: outcome.totals_rows,
        queries: outcome.query_rows,
        pages: outcome.page_rows,
        breakdowns: outcome.breakdown_rows,
        truncated: outcome.queries_truncated || outcome.pages_truncated,
        error: outcome.error_code ?? null,
        backfill_complete: outcome.backfill_complete,
      })),
    }, dailyComplete ? null : errorCodeValue);
    await finishSyncState(db, {
      startedAt, finishedAt, lastSuccessAt, errorCode: dailyComplete ? null : errorCodeValue,
    }, nowMs).catch(() => {});

    console.log(JSON.stringify({
      event: 'gsc_collection', scope: options.scope, trigger: options.trigger, status,
      properties_ok: successes, properties_failed: failures, requests, days: daysCollected,
      duration_ms: Date.now() - startedMs,
    }));

    return {
      status, scope: options.scope, trigger: options.trigger, run_id: runId,
      ...(discoveryError ? { reason: discoveryError } : {}),
      properties: outcomes, requests, days_collected: daysCollected, duration_ms: Date.now() - startedMs,
    };
  } finally {
    await releaseLease(db, owner, nowMs).catch(() => {});
  }
}

// Cron entrypoint. The hourly trigger stays in wrangler.analytics.jsonc; this
// function decides whether a run is due and which scope it should use, so the
// schedule cannot silently change shape.
export async function runScheduledGscCollection(
  env: AnalyticsBindings, options: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<GscRunResult> {
  const now = options.now ?? new Date();
  const db = env.ANALYTICS;
  const skipped: GscRunResult = {
    status: 'skipped', scope: null, trigger: 'cron', run_id: null,
    properties: [], requests: 0, days_collected: 0, duration_ms: 0,
  };
  if (!env.GSC_SERVICE_ACCOUNT_JSON) return { ...skipped, reason: 'not_configured' };

  const state = await readSyncState(db);
  const properties = await readPropertyStates(db);
  const lastSuccessMs = state?.last_success_at ? Date.parse(state.last_success_at) : Number.NaN;
  const dailyDue = !Number.isFinite(lastSuccessMs) || now.getTime() - lastSuccessMs >= DAILY_MIN_INTERVAL_HOURS * 3_600_000;
  const backfillPending = GSC_PROPERTIES.some(definition => {
    const row = properties.get(definition.property);
    return !row || row.backfill_complete !== 1;
  });
  if (!dailyDue && !backfillPending) return { ...skipped, reason: 'not_due' };

  const scope: GscScope = dailyDue ? (backfillPending ? 'full' : 'daily') : 'backfill';
  return await runGscCollection(env, {
    scope, trigger: 'cron', now, ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
}
