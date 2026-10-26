import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/types';
import { jobForCron, runCollectionJob, validateObservation } from '../../src/bitcoin-signals/collector';
import { evaluateAlerts, readSettings } from '../../src/bitcoin-signals/alerts';
import { COLLECTORS } from '../../src/bitcoin-signals/sources';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_SIGNALS_MIGRATIONS: { name: string; queries: string[] }[];
};

import { NOW, NOW_MS, HOUR, URLS, stubFetch } from './fixtures';

async function observationCount(series?: string): Promise<number> {
  const row = series
    ? await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) AS n FROM bs_observations WHERE series = ?').bind(series).first<{ n: number }>()
    : await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) AS n FROM bs_observations').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.BTC_SIGNALS, bindings.TEST_SIGNALS_MIGRATIONS);
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.BTC_SIGNALS.batch([
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_alert_deliveries'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_alerts'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_evidence_hypotheses'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_evidence'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_backup_checks'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_source_runs'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_observations'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_collection_runs'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_collection_locks'),
    bindings.BTC_SIGNALS.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":false,\"email_to\":\"\"}' WHERE key = 'alerts.notifications'"),
    bindings.BTC_SIGNALS.prepare("UPDATE bs_settings SET value_json = '{\"feeBpsPerLeg\":2,\"slippageBpsPerLeg\":1,\"legs\":4,\"holdingDays\":30}' WHERE key = 'arbitrage.assumptions'"),
  ]);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('hourly collection', () => {
  it('collects only permitted active sources with attribution and never calls disabled providers', async () => {
    const fetchImpl = vi.fn(stubFetch());
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'cron', now: NOW, fetchImpl, skipAlerts: true });
    expect(result.sources.filter(source => source.status === 'failed')).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.sources.map(source => source.source_id)).toEqual(['okx', 'kraken-futures', 'kraken-spot', 'coinbase-spot', 'mempool-space']);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([URLS.coinbase, URLS.mempool]));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(result.observations_added).toBe(14);

    expect(await observationCount('funding_current_8h')).toBe(2);
    expect(await observationCount('funding_settled_8h')).toBe(2);
    const spot = await bindings.BTC_SIGNALS.prepare("SELECT source_id, value, tier, revision, run_id FROM bs_observations WHERE series = 'spot_price_usd' AND source_id = 'coinbase-spot'").first();
    expect(spot).toMatchObject({ source_id: 'coinbase-spot', value: 80560.61, tier: 'measured', revision: 1, run_id: result.run_id });

    const lightning = await bindings.BTC_SIGNALS.prepare(
      "SELECT series, value, source_url FROM bs_observations WHERE series LIKE 'lightning_%' ORDER BY series")
      .all<{ series: string; value: number; source_url: string }>();
    expect(lightning.results).toHaveLength(3);
    const capacity = lightning.results.find(row => row.series === 'lightning_capacity_btc')!;
    expect(capacity.value).toBeCloseTo(343_455.880451, 6);
    expect(capacity.source_url).toBe(URLS.mempool);
    expect(lightning.results.every(row => row.series.startsWith('lightning_'))).toBe(true);

    expect(await observationCount('dated_future_mark_usd')).toBe(1);
  });

  it('is idempotent: a second collection adds nothing and rewrites nothing', async () => {
    const first = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    const before = await observationCount();
    const snapshot = await bindings.BTC_SIGNALS.prepare('SELECT id, value, run_id FROM bs_observations ORDER BY id')
      .all<{ id: number; value: number; run_id: string }>();
    // The same collection clock: a repeat of the same measurement is a no-op. A
    // later clock would legitimately add a new mempool snapshot, which has no
    // source timestamp of its own.
    const second = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(second.observations_added).toBe(0);
    expect(await observationCount()).toBe(before);
    const after = await bindings.BTC_SIGNALS.prepare('SELECT id, value, run_id FROM bs_observations ORDER BY id')
      .all<{ id: number; value: number; run_id: string }>();
    // Same rows, same run id: the original provenance is preserved.
    expect(after.results).toEqual(snapshot.results);
    expect(first.run_id).not.toBe(second.run_id);
  });

  it('isolates a failing source and keeps retained history intact', async () => {
    await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    const before = await observationCount();
    const timestamped = await bindings.BTC_SIGNALS.prepare(
      "SELECT id, source_id, series, observed_at, value, run_id FROM bs_observations WHERE meta_json NOT LIKE '%observed_at_source%' ORDER BY id")
      .all();
    const failing = stubFetch({
      [URLS.coinbase]: () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }),
    });
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: new Date(NOW_MS + 60_000), fetchImpl: failing, skipAlerts: true });
    expect(result.status).toBe('partial');
    const coinbase = result.sources.find(source => source.source_id === 'coinbase-spot')!;
    expect(coinbase.status).toBe('failed');
    expect(coinbase.error_code).toBe('http_503');
    // Every retained source-timestamped observation is byte-for-byte unchanged;
    // only retrieval-time Kraken spot and mempool rows are new.
    const timestampedAfter = await bindings.BTC_SIGNALS.prepare(
      "SELECT id, source_id, series, observed_at, value, run_id FROM bs_observations WHERE meta_json NOT LIKE '%observed_at_source%' ORDER BY id")
      .all();
    expect(timestampedAfter.results).toEqual(timestamped.results);
    // Only the four retrieval-time Kraken spot and mempool rows are new.
    expect(await observationCount()).toBe(before + 4);
    const failure = await bindings.BTC_SIGNALS.prepare("SELECT error_code, status FROM bs_source_runs WHERE source_id = 'coinbase-spot' ORDER BY started_at DESC LIMIT 1")
      .first<{ error_code: string; status: string }>();
    expect(failure).toMatchObject({ error_code: 'http_503', status: 'failed' });
    const run = await bindings.BTC_SIGNALS.prepare('SELECT status, sources_failed, detail FROM bs_collection_runs WHERE id = ?').bind(result.run_id).first<{ status: string; sources_failed: number; detail: string }>();
    expect(run).toMatchObject({ status: 'partial', sources_failed: 1 });
    expect(run!.detail).toContain('1 of 5');
  });

  it('rejects an implausible payload instead of storing it', async () => {
    const broken = stubFetch({
      [URLS.coinbase]: () => new Response(JSON.stringify({ price: 'not-a-price', time: NOW.toISOString() }), { headers: { 'content-type': 'application/json' } }),
    });
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: broken, skipAlerts: true });
    expect(result.status).toBe('partial');
    expect(result.sources.find(source => source.source_id === 'coinbase-spot')).toMatchObject({ status: 'failed', error_code: 'shape' });
    expect(await observationCount('spot_price_usd')).toBe(2);
    expect(await observationCount('lightning_node_count')).toBe(1);
  });

  it('rejects a future-dated or malformed observation before it reaches the database', () => {
    const collector = COLLECTORS[0]!;
    expect(validateObservation({ series: 'spot_price_usd', venue: 'okx', observedAt: new Date(NOW_MS + HOUR).toISOString(), value: 1 }, collector, NOW)).toEqual({ ok: false, reason: 'future_observation' });
    expect(validateObservation({ series: 'spot_price_usd', venue: 'okx', observedAt: '2026-10-25', value: 1 }, collector, NOW)).toEqual({ ok: false, reason: 'invalid_observed_at' });
    expect(validateObservation({ series: 'spot_price_usd', venue: 'bad venue!', observedAt: NOW.toISOString(), value: 1 }, collector, NOW)).toEqual({ ok: false, reason: 'invalid_venue' });
    expect(validateObservation({ series: 'spot_price_usd', venue: 'okx', observedAt: NOW.toISOString(), value: Number.NaN }, collector, NOW)).toEqual({ ok: false, reason: 'non_finite_value' });
    expect(validateObservation({ series: 'spot_price_usd', venue: 'okx', observedAt: NOW.toISOString(), value: 1, meta: { blob: 'x'.repeat(4000) } }, collector, NOW)).toEqual({ ok: false, reason: 'metadata_too_large' });
    const accepted = validateObservation({ series: 'spot_price_usd', venue: 'okx', observedAt: NOW.toISOString(), value: 80500 }, collector, NOW);
    expect(accepted.ok).toBe(true);
  });
});

describe('scheduling protection', () => {
  it('maps each cron expression to its own job', () => {
    expect(jobForCron('7 * * * *')).toBe('hourly');
    expect(jobForCron('41 6 * * *')).toBe('daily');
    expect(() => jobForCron('0 0 * * *')).toThrow(/unrecognized/);
  });

  it('collects daily reported treasury history with attribution, authentication and idempotent repeats', async () => {
    const fetchImpl = vi.fn(stubFetch());
    const result = await runCollectionJob(bindings, 'daily', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(result.status).toBe('ok');
    expect(result.sources.map(source => source.source_id)).toEqual(['coingecko-treasury']);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([URLS.coingecko]);
    expect(result.observations_added).toBe(5);
    const row = await bindings.BTC_SIGNALS.prepare("SELECT value, tier, source_url FROM bs_observations WHERE series = 'treasury_total_btc'").first();
    expect(row).toMatchObject({ value: 1303574.21, tier: 'reported', source_url: URLS.coingecko });
    const repeat = await runCollectionJob(bindings, 'daily', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(repeat.observations_added).toBe(0);
    expect(await observationCount()).toBe(5);
  });

  it('authenticates the CoinGecko request without leaking the key into the URL, storage or result', async () => {
    const key = bindings.COINGECKO_DEMO_API_KEY!;
    expect(key).toBeTruthy();
    const fetchImpl = vi.fn(stubFetch());
    const result = await runCollectionJob(bindings, 'daily', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(result.status).toBe('ok');
    // The key travels in the documented Demo header and nowhere else.
    const [requestedUrl, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(requestedUrl).toBe(URLS.coingecko);
    expect(requestedUrl).not.toContain(key);
    expect(init.headers).toMatchObject({ 'x-cg-demo-api-key': key });
    // It is not persisted as evidence, provenance, a value or a diagnostic.
    const observations = await bindings.BTC_SIGNALS.prepare('SELECT source_url, meta_json, unit, definition FROM bs_observations').all();
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(observations.results)).not.toContain(key);
    const runs = await bindings.BTC_SIGNALS.prepare('SELECT status, error_code, error_message FROM bs_source_runs').all();
    expect(JSON.stringify(runs.results)).not.toContain(key);
  });

  it('records a provider rate limit for that source only and writes no treasury history', async () => {
    const key = bindings.COINGECKO_DEMO_API_KEY!;
    const fetchImpl = vi.fn(stubFetch({
      [URLS.coingecko]: () => new Response(JSON.stringify({ status: { error_code: 429, error_message: 'rate limited' } }),
        { status: 429, headers: { 'content-type': 'application/json' } }),
    }));
    const result = await runCollectionJob(bindings, 'daily', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(result.status).toBe('failed');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ source_id: 'coingecko-treasury', status: 'failed', observations_added: 0, error_code: 'http_429' });
    // The authenticated request was actually attempted, and the failure is stored
    // as a stable code with a sanitized message that cannot carry a credential.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'x-cg-demo-api-key': key });
    const run = await bindings.BTC_SIGNALS.prepare("SELECT status, error_code, error_message FROM bs_source_runs WHERE source_id = 'coingecko-treasury'").first();
    expect(run).toMatchObject({ status: 'failed', error_code: 'http_429', error_message: 'the source answered HTTP 429' });
    expect(await observationCount('treasury_total_btc')).toBe(0);
    expect(await observationCount()).toBe(0);
    // A rate limit is a provider condition, not a configuration claim, and the
    // next permitted attempt is not blocked by a broken lease.
    const lock = await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) AS n FROM bs_collection_locks').first<{ n: number }>();
    expect(Number(lock!.n)).toBe(0);
  });

  it('fails only the CoinGecko source when the Demo key is not configured', async () => {
    const withoutKey = { ...bindings, COINGECKO_DEMO_API_KEY: undefined } as unknown as Bindings;
    const fetchImpl = vi.fn(stubFetch());
    const result = await runCollectionJob(withoutKey, 'daily', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(result.status).toBe('failed');
    expect(result.sources[0]).toMatchObject({ source_id: 'coingecko-treasury', status: 'failed', error_code: 'missing_credential' });
    expect(result.sources[0]!.error_message).toBe('the source requires a configured API key');
    // Nothing was sent unauthenticated: an unconfigured key is not a provider error.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await observationCount()).toBe(0);
    // The hourly job, which needs no credential, is unaffected.
    const hourly = await runCollectionJob(withoutKey, 'hourly', { trigger: 'manual', now: NOW, fetchImpl, skipAlerts: true });
    expect(hourly.status).toBe('ok');
    expect(hourly.sources.every(source => source.status === 'ok')).toBe(true);
  });

  it('refuses to overlap a lease held by another run', async () => {
    await bindings.BTC_SIGNALS.prepare('INSERT INTO bs_collection_locks (job, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind('hourly', 'held-by-another-run', NOW.toISOString(), new Date(NOW_MS + 10 * 60_000).toISOString()).run();
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('lease_held');
    expect(result.run_id).toBeNull();
    const runs = await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) AS n FROM bs_collection_runs').first<{ n: number }>();
    expect(Number(runs!.n)).toBe(0);
  });

  it('takes a stale lease so a crashed run cannot block collection forever', async () => {
    await bindings.BTC_SIGNALS.prepare('INSERT INTO bs_collection_locks (job, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind('hourly', 'expired-run', new Date(NOW_MS - 30 * 60_000).toISOString(), new Date(NOW_MS - 20 * 60_000).toISOString()).run();
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'cron', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    expect(result.status).toBe('ok');
    const lock = await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) AS n FROM bs_collection_locks').first<{ n: number }>();
    expect(Number(lock!.n)).toBe(0);
  });

  it('does not duplicate a scheduled collection inside the minimum interval', async () => {
    await runCollectionJob(bindings, 'hourly', { trigger: 'cron', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
    const duplicate = await runCollectionJob(bindings, 'hourly', { trigger: 'cron', now: new Date(NOW_MS + 10 * 60_000), fetchImpl: stubFetch(), skipAlerts: true });
    expect(duplicate.status).toBe('skipped');
    expect(duplicate.reason).toBe('interval_not_elapsed');
    const next = await runCollectionJob(bindings, 'hourly', { trigger: 'cron', now: new Date(NOW_MS + 61 * 60_000), fetchImpl: stubFetch(), skipAlerts: true });
    expect(next.status).toBe('ok');
  });

  it('limits administrator manual refreshes to four per hour', async () => {
    for (let index = 0; index < 4; index += 1) {
      const run = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: new Date(NOW_MS + index * 60_000), fetchImpl: stubFetch(), skipAlerts: true });
      expect(run.status).toBe('ok');
    }
    const limited = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: new Date(NOW_MS + 5 * 60_000), fetchImpl: stubFetch(), skipAlerts: true });
    expect(limited.status).toBe('skipped');
    expect(limited.reason).toBe('manual_rate_limited');
  });
});

describe('alerts', () => {
  async function seedFunding(venue: string, rate: number, samples: number, now: Date): Promise<void> {
    const statements = [];
    for (let index = 0; index < samples; index += 1) {
      const at = new Date(now.getTime() - index * HOUR).toISOString();
      statements.push(bindings.BTC_SIGNALS.prepare(
        `INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, revision, run_id, meta_json)
         VALUES ('curated-research', ?, 'funding_current_8h', ?, ?, ?, ?, 'fraction per 8h', 'test', 'measured', 1, 'seed', '{}')`)
        .bind('https://research.example.test/synthetic-fixture', venue, at, at, rate));
    }
    await bindings.BTC_SIGNALS.batch(statements);
  }

  it('raises one sustained-funding alert per venue per day and never duplicates it', async () => {
    await seedFunding('okx', 0.0006, 6, NOW);
    const first = await evaluateAlerts(bindings, { now: NOW });
    expect(first.rules).toContain('funding-sustained');
    const alerts = await bindings.BTC_SIGNALS.prepare("SELECT id, severity, observed_value, threshold FROM bs_alerts WHERE rule_id = 'funding-sustained'")
      .all<{ id: string; severity: string; observed_value: number; threshold: number }>();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0]!.severity).toBe('warning');
    expect(alerts.results[0]!.observed_value).toBeCloseTo(6, 6);
    expect(alerts.results[0]!.threshold).toBe(5);
    const second = await evaluateAlerts(bindings, { now: new Date(NOW_MS + HOUR) });
    expect(second.created).toBe(0);
    const stillOne = await bindings.BTC_SIGNALS.prepare("SELECT COUNT(*) AS n FROM bs_alerts WHERE rule_id = 'funding-sustained'").first<{ n: number }>();
    expect(Number(stillOne!.n)).toBe(1);
  });

  it('does not raise funding alerts below the threshold or without enough samples', async () => {
    await seedFunding('okx', 0.0001, 6, NOW);
    await seedFunding('deribit', 0.0009, 3, NOW);
    const evaluation = await evaluateAlerts(bindings, { now: NOW });
    expect(evaluation.rules).not.toContain('funding-sustained');
  });

  it('does not alert on stale quotes or future observations', async () => {
    await seedFunding('okx', 0.0006, 6, new Date(NOW_MS - 4 * HOUR));
    await seedFunding('future', 0.0006, 6, new Date(NOW_MS + 12 * HOUR));
    const evaluation = await evaluateAlerts(bindings, { now: NOW });
    expect(evaluation.rules).not.toContain('funding-sustained');
  });

  it('never redelivers the same alert on repeated evaluation', async () => {
    await bindings.BTC_SIGNALS.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":true,\"email_to\":\"research@example.com\"}' WHERE key = 'alerts.notifications'").run();
    const send = vi.fn(async () => ({ messageId: 'test' }));
    await seedFunding('okx', 0.0006, 6, NOW);
    const withMail = { ...bindings, EMAIL: { send } } as unknown as Bindings;
    await Promise.all([evaluateAlerts(withMail, { now: NOW }), evaluateAlerts(withMail, { now: NOW })]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retains the daily-source history despite hundreds of newer hourly runs', async () => {
    const at = new Date(NOW_MS - 30 * HOUR).toISOString();
    await bindings.BTC_SIGNALS.batch([
      bindings.BTC_SIGNALS.prepare("INSERT INTO bs_collection_runs (id, job, trigger, started_at, status) VALUES ('daily-old', 'daily', 'cron', ?, 'ok')").bind(at),
      bindings.BTC_SIGNALS.prepare("INSERT INTO bs_source_runs (run_id, source_id, status, started_at, finished_at, duration_ms) VALUES ('daily-old', 'coingecko-treasury', 'ok', ?, ?, 1)").bind(at, at),
    ]);
    for (let batch = 0; batch < 6; batch++) {
      const statements: D1PreparedStatement[] = [];
      for (let i = 0; i < 40; i++) {
        const id = `hour-${batch}-${i}`;
        statements.push(bindings.BTC_SIGNALS.prepare("INSERT INTO bs_collection_runs (id, job, trigger, started_at, status) VALUES (?, 'hourly', 'cron', ?, 'ok')").bind(id, NOW.toISOString()));
        statements.push(bindings.BTC_SIGNALS.prepare("INSERT INTO bs_source_runs (run_id, source_id, status, started_at, finished_at, duration_ms) VALUES (?, 'okx', 'ok', ?, ?, 1)").bind(id, NOW.toISOString(), NOW.toISOString()));
      }
      await bindings.BTC_SIGNALS.batch(statements);
    }
    await evaluateAlerts(bindings, { now: NOW });
    const falseAlert = await bindings.BTC_SIGNALS.prepare("SELECT id FROM bs_alerts WHERE dedupe_key LIKE 'coingecko-treasury:%'").first();
    expect(falseAlert).toBeNull();
  });

  it('delivers email only when notifications are enabled, and records the delivery', async () => {
    await bindings.BTC_SIGNALS.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":true,\"email_to\":\"research@example.com\"}' WHERE key = 'alerts.notifications'").run();
    const send = vi.fn(async () => ({ messageId: 'test-message' }));
    const withMail = { ...bindings, EMAIL: { send } } as unknown as Bindings;
    await seedFunding('okx', 0.0006, 6, NOW);
    const evaluation = await evaluateAlerts(withMail, { now: NOW });
    expect(evaluation.created).toBeGreaterThan(0);
    // One email per newly created alert; the stale-source rule also fires because
    // no collection has succeeded yet in this isolated database.
    expect(send).toHaveBeenCalledTimes(evaluation.created);
    const deliveries = await bindings.BTC_SIGNALS.prepare('SELECT channel, recipient, status FROM bs_alert_deliveries')
      .all<{ channel: string; recipient: string; status: string }>();
    expect(deliveries.results).toHaveLength(evaluation.created);
    expect(deliveries.results.every(row => row.channel === 'email' && row.recipient === 'research@example.com' && row.status === 'sent')).toBe(true);
  });

  it('records a failed delivery instead of losing the alert', async () => {
    await bindings.BTC_SIGNALS.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":true,\"email_to\":\"research@example.com\"}' WHERE key = 'alerts.notifications'").run();
    const withBrokenMail = { ...bindings, EMAIL: { send: async () => { throw Object.assign(new Error('rejected'), { code: 'E_RECIPIENT_SUPPRESSED' }); } } } as unknown as Bindings;
    await seedFunding('okx', 0.0006, 6, NOW);
    await evaluateAlerts(withBrokenMail, { now: NOW });
    const delivery = await bindings.BTC_SIGNALS.prepare('SELECT status, error_code FROM bs_alert_deliveries LIMIT 1').first<{ status: string; error_code: string }>();
    expect(delivery).toMatchObject({ status: 'failed' });
    expect(delivery!.error_code).toBeTruthy();
    const alert = await bindings.BTC_SIGNALS.prepare("SELECT COUNT(*) AS n FROM bs_alerts WHERE rule_id = 'funding-sustained'").first<{ n: number }>();
    expect(Number(alert!.n)).toBe(1);
  });

  it('alerts on a material reported treasury change', async () => {
    const statements = [
      ['2026-10-23T06:00:00.000Z', 1_000_000],
      ['2026-10-24T06:00:00.000Z', 1_060_000],
    ].map(([at, value]) => bindings.BTC_SIGNALS.prepare(
      `INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, revision, run_id, meta_json)
       VALUES ('curated-research', ?, 'treasury_total_btc', 'public-companies', ?, ?, ?, 'BTC', 'test', 'reported', 1, 'seed', '{}')`)
      .bind('https://research.example.test/synthetic-fixture', at as string, at as string, value as number));
    await bindings.BTC_SIGNALS.batch(statements);
    const evaluation = await evaluateAlerts(bindings, { now: NOW });
    expect(evaluation.rules).toContain('treasury-change');
    const alert = await bindings.BTC_SIGNALS.prepare("SELECT observed_value FROM bs_alerts WHERE rule_id = 'treasury-change'").first<{ observed_value: number }>();
    expect(alert!.observed_value).toBeCloseTo(60_000, 6);
  });

  it('flags a source that has been attempted but never collected successfully', async () => {
    // Nothing has run yet: a fresh installation raises no stale alerts.
    await evaluateAlerts(bindings, { now: NOW });
    const before = await bindings.BTC_SIGNALS.prepare("SELECT COUNT(*) AS n FROM bs_alerts WHERE rule_id = 'stale-source'").first<{ n: number }>();
    expect(Number(before!.n)).toBe(0);

    const runId = crypto.randomUUID();
    await bindings.BTC_SIGNALS.batch([
      bindings.BTC_SIGNALS.prepare("INSERT INTO bs_collection_runs (id, job, trigger, started_at, finished_at, status, sources_total, sources_failed) VALUES (?, 'hourly', 'cron', ?, ?, 'failed', 1, 1)")
        .bind(runId, new Date(NOW_MS - HOUR).toISOString(), NOW.toISOString()),
      bindings.BTC_SIGNALS.prepare("INSERT INTO bs_source_runs (run_id, source_id, status, started_at, finished_at, duration_ms, error_code) VALUES (?, 'coinbase-spot', 'failed', ?, ?, 10, 'http_503')")
        .bind(runId, new Date(NOW_MS - HOUR).toISOString(), NOW.toISOString()),
    ]);
    const evaluation = await evaluateAlerts(bindings, { now: NOW });
    expect(evaluation.rules).toContain('stale-source');
    const stale = await bindings.BTC_SIGNALS.prepare("SELECT dedupe_key FROM bs_alerts WHERE rule_id = 'stale-source' ORDER BY dedupe_key")
      .all<{ dedupe_key: string }>();
    expect(stale.results.map(row => row.dedupe_key)).toContain(`coinbase-spot:${NOW.toISOString().slice(0, 10)}`);
  });

  it('keeps notifications off by default', async () => {
    const settings = await readSettings(bindings.BTC_SIGNALS);
    expect(settings.notifications).toEqual({ enabled: false, email_to: '' });
    expect(settings.rules.funding_threshold_bps_8h).toBe(5);
  });
});
