import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/types';
import { SOURCE_POLICY, isSourceEnabled } from '../../src/bitcoin-signals/policy';
import { collectorsFor, fetchJsonFromAllowlist } from '../../src/bitcoin-signals/sources';
import { runCollectionJob } from '../../src/bitcoin-signals/collector';
import { alertsView, arbitrageView, exportObservationsCsv, historyPoints, latestByVenue, radarView } from '../../src/bitcoin-signals/queries';
import { evaluateAlerts } from '../../src/bitcoin-signals/alerts';
import { projectStatus } from '../../src/bitcoin-signals/status';
import { createSession } from '../../src/auth/human';
import production from '../../src/index';
import { NOW, stubFetch } from './fixtures';
import { BITCOIN_SIGNALS } from '../../src/projects';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_SIGNALS_MIGRATIONS: { name: string; queries: string[] }[];
};
const db = bindings.BTC_SIGNALS;
const disabled = ['deribit'];

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db, bindings.TEST_SIGNALS_MIGRATIONS);
});
beforeEach(async () => {
  await db.batch(['bs_alert_deliveries', 'bs_alerts', 'bs_observations', 'bs_source_runs', 'bs_collection_runs', 'bs_collection_locks']
    .map(table => db.prepare(`DELETE FROM ${table}`)));
});

async function seed(source: string, series: string, at: string, value: number, venue = source, meta = '{}') {
  await db.prepare(`INSERT INTO bs_observations
    (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, meta_json)
    VALUES (?, 'https://example.test/synthetic-unit-fixture', ?, ?, ?, ?, ?, 'test', 'synthetic offline test only', 'measured', ?)`)
    .bind(source, series, venue, at, at, value, meta).run();
}

it('defaults restricted sources off and refuses network calls even when invoked directly', async () => {
  for (const id of disabled) {
    expect(isSourceEnabled(id)).toBe(false);
    expect(SOURCE_POLICY[id]?.reason.length).toBeGreaterThan(0);
    expect((await db.prepare('SELECT active FROM bs_sources WHERE id = ?').bind(id).first<{ active: number }>())?.active).toBe(0);
  }
  expect(collectorsFor('hourly').map(source => source.id)).toEqual(['okx', 'kraken-futures', 'kraken-spot', 'coinbase-spot', 'mempool-space']);
  expect(collectorsFor('daily').map(source => source.id)).toEqual(['coingecko-treasury']);
  const fetchImpl = vi.fn();
  for (const host of ['www.deribit.com']) {
    await expect(fetchJsonFromAllowlist(`https://${host}/`, fetchImpl as typeof fetch)).rejects.toMatchObject({ code: 'source_disabled' });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('a legacy active registry row cannot enable collection or misreport source status', async () => {
  await db.prepare("UPDATE bs_sources SET active = 1 WHERE id = 'deribit'").run();
  try {
    const fetchImpl = vi.fn(stubFetch());
    const result = await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: fetchImpl as typeof fetch, skipAlerts: true });
    expect(result.sources.some(source => source.source_id === 'deribit')).toBe(false);
    expect(fetchImpl.mock.calls).toHaveLength(8);
    const id = BITCOIN_SIGNALS.ownerUserId;
    const at = new Date().toISOString();
    await bindings.DB.prepare('INSERT INTO users (id, email, active, is_admin, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
      .bind(id, `${id}@example.test`, at, at).run();
    const session = await createSession(bindings, id);
    const response = await production.fetch(new Request('https://cflab.aismallbizguru.com/api/bitcoin-signals/settings', { headers: { Authorization: `Bearer ${session.token}` } }), bindings);
    const settings = await response.json<{ sources: { id: string; active: boolean; disabled_reason: string }[] }>();
    expect(settings.sources.find(source => source.id === 'deribit')).toMatchObject({ active: false, disabled_reason: SOURCE_POLICY.deribit!.reason });
  } finally {
    await db.prepare("UPDATE bs_sources SET active = 0 WHERE id = 'deribit'").run();
  }
});

it('quarantines retained restricted observations from every data-reporting path without deleting history', async () => {
  const at = NOW.toISOString();
  for (const source of disabled) {
    await seed(source, 'spot_price_usd', at, 100000);
    await seed(source, 'funding_current_8h', at, 0.001);
    await seed(source, 'funding_settled_8h', at, 0.001);
    await seed(source, 'dated_future_mark_usd', at, 100000, `${source}:future`, JSON.stringify({ expiry: '2026-12-25T16:00:00.000Z', index_usd: 80000 }));
  }
  const count = Number((await db.prepare('SELECT COUNT(*) AS n FROM bs_observations').first<{ n: number }>())!.n);
  expect(await latestByVenue(db, 'spot_price_usd')).toEqual([]);
  expect(await historyPoints(db, 'spot_price_usd', 'deribit')).toEqual([]);
  const radar = await radarView(db, NOW);
  expect(radar.indicators).toEqual([]);
  expect(radar.collection.sources.find(source => source.source_id === 'deribit')).toMatchObject({ active: false });
  const arbitrage = await arbitrageView(db, { now: NOW });
  expect(arbitrage.venues).toEqual([]);
  expect(arbitrage.basis).toEqual([]);
  expect(arbitrage.best_funding).toBeNull();
  expect(arbitrage.best_basis).toBeNull();
  expect((await exportObservationsCsv(db)).trim().split('\n')).toHaveLength(1);
  expect((await exportObservationsCsv(db, { series: 'spot_price_usd' })).trim().split('\n')).toHaveLength(1);
  const status = await projectStatus(bindings, NOW);
  expect(status.data).toMatchObject({ observations: 0, last_observation_at: null, oldest_observation_at: null });
  expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM bs_observations').first<{ n: number }>())!.n)).toBe(count);
  await seed('coinbase-spot', 'spot_price_usd', at, 81000, 'coinbase');
  expect((await radarView(db, NOW)).indicators[0]?.source_id).toBe('coinbase-spot');
});

it('suppresses restricted legacy alerts and never sends mail for their retained measurements', async () => {
  const at = NOW.toISOString();
  for (let i = 0; i < 6; i++) await seed('deribit', 'funding_current_8h', new Date(NOW.getTime() - i * 3_600_000).toISOString(), 0.001);
  for (const [rule, key] of [['funding-sustained', 'deribit:2026-10-25'], ['stale-source', 'deribit:2026-10-25']]) {
    await db.prepare('INSERT INTO bs_alerts (id, rule_id, dedupe_key, severity, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), rule, key, 'warning', 'synthetic restricted-source alert', 'test', at).run();
  }
  const send = vi.fn();
  await db.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":true,\"email_to\":\"test@example.test\"}' WHERE key = 'alerts.notifications'").run();
  try {
    expect((await evaluateAlerts({ ...bindings, EMAIL: { send } } as unknown as Bindings, { now: NOW })).created).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await alertsView(db)).toEqual([]);
    expect((await radarView(db, NOW)).alerts).toEqual([]);
    expect((await projectStatus(bindings, NOW)).data.alerts_open).toBe(0);
    expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM bs_alerts').first<{ n: number }>())!.n)).toBe(2);
  } finally {
    await db.prepare("UPDATE bs_settings SET value_json = '{\"enabled\":false,\"email_to\":\"\"}' WHERE key = 'alerts.notifications'").run();
  }
});

it('reports permitted personal-research funding and basis while retaining provenance', async () => {
  await runCollectionJob(bindings, 'hourly', { trigger: 'manual', now: NOW, fetchImpl: stubFetch(), skipAlerts: true });
  const view = await arbitrageView(db, { now: NOW });
  expect(view.venues.map(row => row.venue).sort()).toEqual(['kraken-futures', 'okx']);
  expect(view.basis).toHaveLength(1);
  expect(view.basis[0]?.venue).toContain('kraken-futures');
  expect((await exportObservationsCsv(db))).toContain('kraken-futures');
  expect((await projectStatus(bindings, NOW)).data.observations).toBe(14);
});
