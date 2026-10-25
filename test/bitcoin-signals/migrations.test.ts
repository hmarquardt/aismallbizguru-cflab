import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Bindings } from '../../src/types';
import { DATABASES as BACKUP_DATABASES } from '../../scripts/backup/d1-export.mjs';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_ANALYTICS_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_SIGNALS_MIGRATIONS: { name: string; queries: string[] }[];
};

async function tables(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ name: string }>();
  return results.map(row => row.name);
}

async function ledger(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  // Apply each schema to its own database, one at a time, so independence is
  // actually exercised rather than assumed.
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

describe('all three databases migrate independently', () => {
  it('migrates the primary database without creating Bitcoin Signals tables', async () => {
    const names = await tables(bindings.DB);
    expect(names).toEqual(expect.arrayContaining(['apps', 'app_origins', 'api_tokens', 'records', 'files', 'users', 'sessions', 'project_memberships', 'project_storage']));
    expect(names.filter(name => name.startsWith('bs_'))).toEqual([]);
    expect(await ledger(bindings.DB)).toBe(bindings.TEST_MIGRATIONS.length);
  });

  it('migrates the analytics database without touching the primary schema', async () => {
    const before = await tables(bindings.DB);
    await applyD1Migrations(bindings.ANALYTICS, bindings.TEST_ANALYTICS_MIGRATIONS);
    const analytics = await tables(bindings.ANALYTICS);
    expect(analytics).toEqual(expect.arrayContaining(['analytics_sites', 'analytics_events', 'analytics_domains']));
    expect(analytics.filter(name => name.startsWith('bs_'))).toEqual([]);
    expect(await tables(bindings.DB)).toEqual(before);
    expect(await ledger(bindings.ANALYTICS)).toBe(bindings.TEST_ANALYTICS_MIGRATIONS.length);
  });

  it('migrates the Bitcoin Signals database with its own ledger and no identity tables', async () => {
    await applyD1Migrations(bindings.BTC_SIGNALS, bindings.TEST_SIGNALS_MIGRATIONS);
    const names = await tables(bindings.BTC_SIGNALS);
    expect(names).toEqual(expect.arrayContaining([
      'bs_sources', 'bs_collection_runs', 'bs_source_runs', 'bs_observations', 'bs_evidence',
      'bs_hypotheses', 'bs_evidence_hypotheses', 'bs_alerts', 'bs_alert_deliveries', 'bs_settings',
      'bs_backup_checks', 'bs_collection_locks',
    ]));
    expect(names).not.toContain('users');
    expect(names).not.toContain('apps');
    expect(names).not.toContain('records');
    expect(await ledger(bindings.BTC_SIGNALS)).toBe(bindings.TEST_SIGNALS_MIGRATIONS.length);
  });

  it('is idempotent: re-applying every migration set changes nothing', async () => {
    const before = [await ledger(bindings.DB), await ledger(bindings.ANALYTICS), await ledger(bindings.BTC_SIGNALS)];
    await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
    await applyD1Migrations(bindings.ANALYTICS, bindings.TEST_ANALYTICS_MIGRATIONS);
    await applyD1Migrations(bindings.BTC_SIGNALS, bindings.TEST_SIGNALS_MIGRATIONS);
    expect([await ledger(bindings.DB), await ledger(bindings.ANALYTICS), await ledger(bindings.BTC_SIGNALS)]).toEqual(before);
  });

  it('seeds the source registry, the six hypotheses, and notifications off', async () => {
    const sources = await bindings.BTC_SIGNALS.prepare('SELECT id, cadence, default_tier FROM bs_sources ORDER BY id').all<{ id: string; cadence: string; default_tier: string }>();
    expect(sources.results.map(row => row.id)).toEqual(['coinbase-spot', 'coingecko-treasury', 'curated-research', 'deribit', 'kraken-futures', 'kraken-spot', 'mempool-space', 'okx']);
    expect(sources.results.find(row => row.id === 'curated-research')?.cadence).toBe('curated');
    const hypotheses = await bindings.BTC_SIGNALS.prepare('SELECT id FROM bs_hypotheses ORDER BY id').all<{ id: string }>();
    expect(hypotheses.results.map(row => row.id)).toEqual([
      'carry-persistence', 'lightning-commerce', 'retained-asset', 'sovereign-downstream', 'stablecoin-substitution', 'treasury-demand',
    ]);
    const notifications = await bindings.BTC_SIGNALS.prepare("SELECT value_json FROM bs_settings WHERE key = 'alerts.notifications'").first<{ value_json: string }>();
    expect(JSON.parse(notifications!.value_json)).toEqual({ enabled: false, email_to: '' });
    const assumptions = await bindings.BTC_SIGNALS.prepare("SELECT value_json FROM bs_settings WHERE key = 'arbitrage.assumptions'").first<{ value_json: string }>();
    expect(JSON.parse(assumptions!.value_json)).toEqual({ feeBpsPerLeg: 2, slippageBpsPerLeg: 1, legs: 4, holdingDays: 30 });
  });

  it('registers the project identity in the primary database and nothing in its data database', async () => {
    const app = await bindings.DB.prepare("SELECT id, name, active FROM apps WHERE id = 'bitcoin-signals'").first<{ id: string; name: string; active: number }>();
    expect(app).toEqual({ id: 'bitcoin-signals', name: 'Bitcoin Signals', active: 1 });
    const storage = await bindings.DB.prepare("SELECT backend, binding, migrations_dir FROM project_storage WHERE app_id = 'bitcoin-signals'").first<{ backend: string; binding: string; migrations_dir: string }>();
    expect(storage).toEqual({ backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', migrations_dir: 'migrations-bitcoin-signals' });
    const registry = await bindings.BTC_SIGNALS.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'project_storage'").first<{ n: number }>();
    expect(Number(registry!.n)).toBe(0);
  });

  it('keeps every pre-existing table and the existing seed data intact', async () => {
    // Existing projects keep working: the only row added by 0011 is the new project.
    const apps = await bindings.DB.prepare("SELECT id FROM apps ORDER BY id").all<{ id: string }>();
    expect(apps.results.map(row => row.id)).toEqual([
      'analytics-dashboard', 'bitcoin-signals', 'junkstats-dashboard', 'top-hat-ferals', 'wildlife-field-recorder',
    ]);
    const core = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('apps','records','files','api_tokens','users','sessions','password_reset_tokens','app_origins','proxy_sources','project_memberships','project_storage')").first<{ n: number }>();
    expect(Number(core!.n)).toBe(11);
  });

  it('is registered with the backup tooling as a third production database', () => {
    const labels = (BACKUP_DATABASES as { label: string; binding: string; migrationsDir?: string } []).map(database => database.label);
    expect(labels).toContain('cflab-bitcoin-signals');
    expect(labels).toHaveLength(3);
  });
});
