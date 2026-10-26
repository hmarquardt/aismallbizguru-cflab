// Scheduled data collection.
//
// Properties this module guarantees:
//   * a collection run is recorded even when every source fails;
//   * one atomic lease per job prevents overlapping runs, and a minimum interval
//     prevents a duplicated cron from collecting twice;
//   * each source is isolated: a timeout, a bad shape, or an implausible value
//     fails that source only;
//   * observations are idempotent (unique key + DO NOTHING), so a repeat never
//     rewrites retained history;
//   * nothing is written when a value cannot be validated, so a partial source
//     outage never corrupts what is already stored.

import type { Bindings } from '../types';
import { SERIES, SourcePayloadError, collectorsFor, fetchJsonFromAllowlist, sourceRequestHeaders, type Collector, type RawObservation } from './sources';
import { evaluateAlerts } from './alerts';

export const HOURLY_MIN_INTERVAL_MINUTES = 50;
export const DAILY_MIN_INTERVAL_HOURS = 20;
export const MANUAL_RUNS_PER_HOUR = 4;
export const LOCK_TTL_MINUTES = 10;
export const MAX_OBSERVATION_AGE_DAYS = 120;
export const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
export const MAX_META_BYTES = 2000;
const INSERT_CHUNK = 40;

export type CollectionJob = 'hourly' | 'daily';
export type CollectionScope = 'hourly' | 'daily' | 'all';
export type CollectionStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export interface CollectionOptions {
  trigger: 'cron' | 'manual';
  userId?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  skipAlerts?: boolean;
}

export interface SourceOutcome {
  source_id: string;
  status: 'ok' | 'failed' | 'empty';
  observations_seen: number;
  observations_added: number;
  duration_ms: number;
  error_code?: string;
  error_message?: string;
}

export interface CollectionResult {
  status: CollectionStatus;
  job: CollectionJob;
  run_id: string | null;
  reason?: string;
  sources: SourceOutcome[];
  observations_seen: number;
  observations_added: number;
}

const VENUE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ValidatedObservation {
  series: RawObservation['series'];
  venue: string;
  observedAt: string;
  value: number;
  url: string;
  meta: Record<string, unknown>;
}

// Rejects anything that cannot be stored honestly: an unknown series, a venue
// that is not a slug, a non-finite value, a malformed or implausible timestamp,
// or metadata large enough to be a payload rather than provenance.
export function validateObservation(observation: RawObservation, collector: Collector, now: Date): { ok: true; value: ValidatedObservation } | { ok: false; reason: string } {
  if (!Object.prototype.hasOwnProperty.call(SERIES, observation.series)) return { ok: false, reason: 'unknown_series' };
  if (typeof observation.venue !== 'string' || !VENUE_PATTERN.test(observation.venue)) return { ok: false, reason: 'invalid_venue' };
  if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) return { ok: false, reason: 'non_finite_value' };
  if (typeof observation.observedAt !== 'string' || !ISO_PATTERN.test(observation.observedAt) || !Number.isFinite(Date.parse(observation.observedAt))) {
    return { ok: false, reason: 'invalid_observed_at' };
  }
  const age = now.getTime() - Date.parse(observation.observedAt);
  if (age < -FUTURE_TOLERANCE_MS) return { ok: false, reason: 'future_observation' };
  if (age > MAX_OBSERVATION_AGE_DAYS * 86_400_000) return { ok: false, reason: 'observation_too_old' };
  const meta = observation.meta ?? {};
  const metaJson = JSON.stringify(meta);
  if (metaJson.length > MAX_META_BYTES) return { ok: false, reason: 'metadata_too_large' };
  return {
    ok: true,
    value: {
      series: observation.series, venue: observation.venue, observedAt: observation.observedAt,
      value: observation.value, url: observation.url ?? collector.url, meta,
    },
  };
}

async function acquireLease(db: D1Database, job: CollectionJob, runId: string, now: Date): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MINUTES * 60_000).toISOString();
  const result = await db.prepare(
    `INSERT INTO bs_collection_locks (job, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET run_id = excluded.run_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
     WHERE bs_collection_locks.expires_at <= ?`)
    .bind(job, runId, now.toISOString(), expiresAt, now.toISOString()).run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, job: CollectionJob, runId: string): Promise<void> {
  await db.prepare('DELETE FROM bs_collection_locks WHERE job = ? AND run_id = ?').bind(job, runId).run();
}

async function recentRun(db: D1Database, job: CollectionJob): Promise<{ started_at: string } | null> {
  return await db.prepare("SELECT started_at FROM bs_collection_runs WHERE job = ? AND status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1")
    .bind(job).first<{ started_at: string }>();
}

async function finishRun(db: D1Database, runId: string, patch: Record<string, unknown>): Promise<void> {
  await db.prepare('UPDATE bs_collection_runs SET finished_at = ?, status = ?, detail = ?, sources_total = ?, sources_ok = ?, sources_failed = ?, observations_seen = ?, observations_added = ? WHERE id = ?')
    .bind(
      patch.finishedAt ?? null, patch.status ?? 'failed', patch.detail ?? null,
      patch.sourcesTotal ?? 0, patch.sourcesOk ?? 0, patch.sourcesFailed ?? 0,
      patch.observationsSeen ?? 0, patch.observationsAdded ?? 0, runId,
    ).run();
}

interface InsertRow extends ValidatedObservation { sourceId: string; retrievedAt: string; unit: string; definition: string; tier: string }

async function insertObservations(db: D1Database, runId: string, rows: InsertRow[]): Promise<number> {
  if (!rows.length) return 0;
  let added = 0;
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    const chunk = rows.slice(index, index + INSERT_CHUNK);
    const statements = chunk.map(row => db.prepare(
      `INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, revision, run_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (source_id, series, venue, observed_at, revision) DO NOTHING`)
      .bind(row.sourceId, row.url, row.series, row.venue, row.observedAt, row.retrievedAt, row.value, row.unit, row.definition, row.tier, runId, JSON.stringify(row.meta)));
    const results = await db.batch(statements);
    for (const result of results) added += Number(result.meta?.changes ?? 0) > 0 ? 1 : 0;
  }
  return added;
}

// Runs one collection job. Returns the outcome instead of throwing for an
// ordinary condition (lease held, interval not elapsed, rate limited); a database
// failure propagates so the caller can see it.
export async function runCollectionJob(env: Bindings, job: CollectionJob, options: CollectionOptions): Promise<CollectionResult> {
  const db = env.BTC_SIGNALS;
  const now = options.now ?? new Date();
  const runId = crypto.randomUUID();
  const empty = (status: CollectionStatus, reason?: string): CollectionResult => ({
    status, job, run_id: status === 'skipped' ? null : runId, reason, sources: [], observations_seen: 0, observations_added: 0,
  });

  if (!await acquireLease(db, job, runId, now)) return empty('skipped', 'lease_held');
  const outcomes: SourceOutcome[] = [];
  let collectors: Collector[] = [];
  let seen = 0;
  let added = 0;
  let recorded = false;
  try {
    const active = await db.prepare('SELECT id FROM bs_sources WHERE active = 1').all<{ id: string }>();
    const activeIds = new Set(active.results.map(source => source.id));
    collectors = collectorsFor(job).filter(collector => activeIds.has(collector.id));
    if (!collectors.length) {
      if (!options.skipAlerts) await evaluateAlerts(env, { job, now });
      return empty('skipped', 'no_enabled_sources');
    }
    if (options.trigger !== 'manual') {
      const last = await recentRun(db, job);
      const intervalMs = job === 'hourly' ? HOURLY_MIN_INTERVAL_MINUTES * 60_000 : DAILY_MIN_INTERVAL_HOURS * 3_600_000;
      if (last && now.getTime() - Date.parse(last.started_at) < intervalMs) return empty('skipped', 'interval_not_elapsed');
    }

    const startedAt = now.toISOString();
    // Count and reserve a manual slot in ONE statement, including across the
    // hourly and daily leases. Concurrent refreshes cannot both take the last slot.
    const reservation = await db.prepare(
      `INSERT INTO bs_collection_runs (id, job, trigger, started_at, status, sources_total, requested_by_user_id)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? = 'cron' OR
         (SELECT COUNT(*) FROM bs_collection_runs WHERE trigger = 'manual' AND started_at >= ?) < ?`)
      .bind(runId, options.trigger === 'manual' ? 'manual' : job, options.trigger, startedAt, 'running', collectors.length, options.userId ?? null,
        options.trigger, new Date(now.getTime() - 3_600_000).toISOString(), MANUAL_RUNS_PER_HOUR).run();
    if (!Number(reservation.meta.changes)) return empty('skipped', 'manual_rate_limited');
    recorded = true;

    const fetchImpl = options.fetchImpl ?? fetch;
    const sourcesStartedAt = new Date().toISOString();
    // Sources run concurrently so the whole job is bounded by the slowest source
    // timeout rather than the sum of them, and every failure is caught locally.
    // Credential headers come from the Worker secret bindings by source name, so a
    // missing key fails that one source with `missing_credential` before a request
    // is made and never affects the other collectors.
    const results = await Promise.allSettled(collectors.map(async collector => {
      const sourceStarted = Date.now();
      const credentialHeaders = sourceRequestHeaders(collector.id, env);
      return { collector, rows: await collector.collect(url => fetchJsonFromAllowlist(url, fetchImpl, credentialHeaders), now), sourceStarted };
    }));

    for (const [index, result] of results.entries()) {
      const collector = collectors[index]!;
      const finishedAt = new Date().toISOString();
      if (result.status === 'rejected') {
        const error = result.reason;
        const isKnown = error instanceof SourcePayloadError;
        const outcome: SourceOutcome = {
          source_id: collector.id, status: 'failed', observations_seen: 0, observations_added: 0,
          duration_ms: Date.now() - Date.parse(sourcesStartedAt), error_code: isKnown ? error.code : 'unexpected_error',
          error_message: isKnown ? error.message.slice(0, 200) : 'the source failed unexpectedly',
        };
        outcomes.push(outcome);
        await recordSourceRun(db, runId, outcome, sourcesStartedAt, finishedAt);
        continue;
      }
      const { rows, sourceStarted } = result.value;
      const validated: InsertRow[] = [];
      let rejected = 0;
      for (const observation of rows) {
        const accepted = validateObservation(observation, collector, now);
        if (!accepted.ok) { rejected += 1; continue; }
        const meta = SERIES[accepted.value.series];
        const quoteIsUsdt = collector.id === 'okx' && meta.group === 'price';
        validated.push({
          ...accepted.value, sourceId: collector.id, retrievedAt: finishedAt,
          unit: quoteIsUsdt ? 'USDT per BTC' : meta.unit,
          definition: quoteIsUsdt ? `${meta.definition.replace(/\bUSD\b/g, 'USDT')} No USDT/USD conversion was performed.` : meta.definition,
          tier: meta.tier,
        });
      }
      const inserted = await insertObservations(db, runId, validated);
      seen += validated.length;
      added += inserted;
      const outcome: SourceOutcome = {
        source_id: collector.id,
        status: rejected ? 'failed' : validated.length === 0 ? 'empty' : 'ok',
        observations_seen: validated.length,
        observations_added: inserted,
        duration_ms: Date.now() - sourceStarted,
        ...(rejected ? { error_code: 'rejected_observations', error_message: `${rejected} observation(s) failed validation` } : {}),
      };
      outcomes.push(outcome);
      await recordSourceRun(db, runId, outcome, sourcesStartedAt, finishedAt);
    }

    const ok = outcomes.filter(outcome => outcome.status === 'ok').length;
    const failed = outcomes.filter(outcome => outcome.status !== 'ok').length;
    const status: CollectionStatus = failed === 0 && ok > 0 ? 'ok' : ok > 0 ? 'partial' : 'failed';
    await finishRun(db, runId, {
      finishedAt: new Date().toISOString(), status,
      detail: failed === 0 ? null : `${failed} of ${outcomes.length} source(s) failed`,
      sourcesTotal: outcomes.length, sourcesOk: ok, sourcesFailed: failed,
      observationsSeen: seen, observationsAdded: added,
    });
    if (!options.skipAlerts) {
      try {
        await evaluateAlerts(env, { job, now: new Date() });
      } catch {
        console.error(JSON.stringify({ event: 'signals_alert_evaluation_failed', job }));
      }
    }
    return { status, job, run_id: runId, sources: outcomes, observations_seen: seen, observations_added: added };
  } catch (error) {
    if (recorded) await finishRun(db, runId, { finishedAt: new Date().toISOString(), status: 'failed', detail: 'the collection run failed', sourcesTotal: collectors.length, sourcesFailed: collectors.length, observationsSeen: seen, observationsAdded: added });
    throw error;
  } finally {
    await releaseLease(db, job, runId);
  }
}

async function recordSourceRun(db: D1Database, runId: string, outcome: SourceOutcome, startedAt: string, finishedAt: string): Promise<void> {
  await db.prepare(
    `INSERT INTO bs_source_runs (run_id, source_id, status, started_at, finished_at, duration_ms, observations_seen, observations_added, error_code, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, source_id) DO NOTHING`)
    .bind(runId, outcome.source_id, outcome.status, startedAt, finishedAt, outcome.duration_ms, outcome.observations_seen, outcome.observations_added, outcome.error_code ?? null, outcome.error_message ?? null)
    .run();
}

// Cron entrypoint. The cron expression decides the job, so a new trigger cannot
// silently run the wrong collection.
export function jobForCron(cron: string): CollectionJob {
  if (cron === '41 6 * * *') return 'daily';
  if (cron === '7 * * * *') return 'hourly';
  throw new Error('unrecognized Bitcoin Signals cron');
}
