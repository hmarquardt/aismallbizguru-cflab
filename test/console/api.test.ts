import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import production from '../../src/index';
import type { Bindings } from '../../src/types';
import { createSession } from '../../src/auth/human';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_ANALYTICS_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_SIGNALS_MIGRATIONS: { name: string; queries: string[] }[];
};
const base = 'https://cflab.aismallbizguru.com';
const MACHINE_TOKEN = `cfl_${'a'.repeat(64)}`;
const DEMO_KEY = 'test-demo-key-not-a-real-secret';

interface SeededUser { id: string; token: string }

async function seedUser(admin: boolean): Promise<SeededUser> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
    .bind(id, `${admin ? 'admin' : 'user'}-${id.slice(0, 8)}@example.com`, admin ? 1 : 0, now, now).run();
  const session = await createSession(bindings, id);
  return { id, token: session.token };
}

async function call(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return await production.fetch(new Request(`${base}${path}`, {
    method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), bindings);
}

async function auditRows(): Promise<{ sql_hash: string; sql_length: number; status: string; error_code: string | null }[]> {
  const { results } = await bindings.DB.prepare('SELECT sql_hash, sql_length, status, error_code FROM console_query_audit ORDER BY created_at').all<{
    sql_hash: string; sql_length: number; status: string; error_code: string | null;
  }>();
  return results;
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.ANALYTICS, bindings.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(bindings.BTC_SIGNALS, bindings.TEST_SIGNALS_MIGRATIONS);
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM console_saved_queries'),
    bindings.DB.prepare('DELETE FROM console_query_audit'),
    bindings.DB.prepare('DELETE FROM project_memberships'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM password_reset_tokens'),
    bindings.DB.prepare('DELETE FROM users'),
  ]);
  await bindings.BTC_SIGNALS.batch([
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_source_runs'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_collection_runs'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_backup_checks'),
    bindings.BTC_SIGNALS.prepare('DELETE FROM bs_collection_locks'),
  ]);
  await bindings.ANALYTICS.prepare('DELETE FROM console_job_runs').run();
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('console access control', () => {
  it('requires an active administrator human session on every route', async () => {
    const user = await seedUser(false);
    const machine = `cflu_${'b'.repeat(64)}`;
    for (const path of ['/api/admin/console/overview', '/api/admin/console/registry', '/api/admin/console/databases', '/api/admin/console/jobs', '/api/admin/console/system']) {
      expect((await call(path)).status).toBe(401);
      expect((await call(path, { token: MACHINE_TOKEN })).status).toBe(401);
      expect((await call(path, { token: machine })).status).toBe(401);
      expect((await call(path, { token: user.token })).status).toBe(403);
    }
    expect((await call('/api/admin/console/databases/primary/query', { method: 'POST', body: { sql: 'SELECT 1' } })).status).toBe(401);
    expect((await call('/api/admin/console/saved-queries', { method: 'POST', body: { name: 'x', database_id: 'primary', sql: 'SELECT 1' } })).status).toBe(401);
    // A refused request never reaches the workbench.
    expect(await auditRows()).toEqual([]);
  });

  it('stops working when the administrator session is revoked or the account is demoted', async () => {
    const admin = await seedUser(true);
    expect((await call('/api/admin/console/overview', { token: admin.token })).status).toBe(200);
    await bindings.DB.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').bind(admin.id).run();
    expect((await call('/api/admin/console/overview', { token: admin.token })).status).toBe(403);
    await bindings.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(admin.id).run();
    expect((await call('/api/admin/console/overview', { token: admin.token })).status).toBe(401);
  });

  it('keeps the existing root shell public but data-free, and /api/health unchanged', async () => {
    const page = await call('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('CFLab operations');
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain('observations</');
    const health = await call('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'cflab' });
  });
});

describe('overview and registry', () => {
  it('summarizes the real deployment without inventing services', async () => {
    const admin = await seedUser(true);
    const response = await call('/api/admin/console/overview', { token: admin.token });
    expect(response.status).toBe(200);
    const body = await response.json<{
      caller: { email: string; is_admin: boolean }; revision: string;
      summary: Record<string, number>; health: { databases: { id: string; reachable: boolean }[] };
      warnings: { severity: string; area: string; message: string }[]; activity: unknown[];
    }>();
    expect(body.caller.is_admin).toBe(true);
    expect(body.revision).toBe('unknown');
    expect(body.summary.databases).toBe(3);
    expect(body.summary.projects).toBeGreaterThanOrEqual(5);
    expect(body.summary.administrators).toBe(1);
    expect(body.health.databases.map(entry => entry.id).sort()).toEqual(['analytics', 'bitcoin-signals', 'primary']);
    expect(body.health.databases.every(entry => entry.reachable)).toBe(true);
    // No attestation and no Signals runs yet: the console reports that honestly.
    expect(body.warnings.map(warning => warning.area)).toContain('backup');
    expect(Array.isArray(body.activity)).toBe(true);
  });

  it('serves a registry seeded from the deployment with access boundaries', async () => {
    const admin = await seedUser(true);
    const body = await (await call('/api/admin/console/registry', { token: admin.token })).json<{
      services: { id: string; endpoints: { method: string; path: string; access: string }[]; resources: { kind: string; reference: string }[] }[];
      repositories: { name: string }[]; jobs: { id: string; schedule: string }[];
      counts: Record<string, number>;
    }>();
    const ids = body.services.map(service => service.id);
    for (const expected of ['cflab-core', 'cflab-admin', 'cflab-analytics', 'bitcoin-signals', 'wildlife-field-recorder', 'top-hat-ferals']) {
      expect(ids).toContain(expected);
    }
    expect(body.counts.endpoints).toBeGreaterThanOrEqual(40);
    const core = body.services.find(service => service.id === 'cflab-core')!;
    expect(core.endpoints.find(endpoint => endpoint.path === '/api/health')?.access).toBe('public');
    expect(core.endpoints.find(endpoint => endpoint.path === '/api/apps/:app/resources/:resource/records')?.access).toBe('project-scope');
    const references = body.services.flatMap(service => service.resources.map(resource => resource.reference));
    for (const expected of ['DB', 'ANALYTICS', 'BTC_SIGNALS', 'FILES']) expect(references).toContain(expected);
    expect(body.repositories.map(repo => repo.name)).toContain('aismallbizguru-cflab');
    expect(body.jobs.map(job => job.schedule)).toEqual(expect.arrayContaining(['7 * * * *', '41 6 * * *', '17 * * * *']));
  });

  it('reports an unknown database as not allowed instead of resolving a binding', async () => {
    const admin = await seedUser(true);
    expect((await call('/api/admin/console/databases/cflab/schema', { token: admin.token })).status).toBe(404);
    expect((await call('/api/admin/console/databases/DB/query', { method: 'POST', body: { sql: 'SELECT 1' }, token: admin.token })).status).toBe(404);
  });
});


describe('database explorer', () => {
  it('lists exactly the bound databases, with schema and isolation between them', async () => {
    const admin = await seedUser(true);
    const list = await (await call('/api/admin/console/databases', { token: admin.token })).json<{
      databases: { id: string; binding: string; reachable: boolean; tables: number; sqlite_version: string | null }[];
    }>();
    expect(list.databases.map(database => database.id).sort()).toEqual(['analytics', 'bitcoin-signals', 'primary']);
    expect(list.databases.map(database => database.binding).sort()).toEqual(['ANALYTICS', 'BTC_SIGNALS', 'DB']);
    expect(list.databases.every(database => database.reachable)).toBe(true);
    expect(list.databases.every(database => database.tables > 0)).toBe(true);

    const primary = await (await call('/api/admin/console/databases/primary/schema', { token: admin.token })).json<{
      tables: { name: string; columns: { name: string }[]; indexes: { name: string }[] }[];
    }>();
    const users = primary.tables.find(table => table.name === 'users')!;
    expect(users.columns.map(column => column.name)).toContain('email');
    expect(users.indexes.length).toBeGreaterThan(0);

    const analytics = await (await call('/api/admin/console/databases/analytics/schema', { token: admin.token })).json<{
      tables: { name: string }[];
    }>();
    const analyticsTables = analytics.tables.map(table => table.name);
    expect(analyticsTables).toContain('analytics_sites');
    // The explorer cannot see across databases: primary tables are absent here.
    expect(analyticsTables).not.toContain('users');
    expect(analyticsTables).not.toContain('console_services');
  });

  it('executes one read-only statement with bounded pages and metrics', async () => {
    const admin = await seedUser(true);
    const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 120) SELECT x FROM c';
    const page = await call('/api/admin/console/databases/primary/query', {
      method: 'POST', token: admin.token, body: { sql, page: 1, page_size: 50 },
    });
    expect(page.status).toBe(200);
    const first = await page.json<{ columns: string[]; rows: number[][]; metrics: { page: number; has_more: boolean; page_size: number; duration_ms: number } }>();
    expect(first.columns).toEqual(['x']);
    expect(first.rows).toHaveLength(50);
    expect(first.metrics).toMatchObject({ page: 1, page_size: 50, has_more: true });

    const third = await (await call('/api/admin/console/databases/primary/query', {
      method: 'POST', token: admin.token, body: { sql, page: 3, page_size: 50 },
    })).json<{ rows: number[][]; metrics: { has_more: boolean } }>();
    expect(third.rows).toHaveLength(20);
    expect(third.metrics.has_more).toBe(false);

    const [audit] = await auditRows();
    expect(audit).toMatchObject({ status: 'ok' });
    expect(audit!.sql_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('read-only execution and audit', () => {
  it('refuses writes, DDL, pragmas, multiple statements and parameters without changing data', async () => {
    const admin = await seedUser(true);
    const before = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    const attempts: [string, string][] = [
      ['DELETE FROM users', 'sql_not_select'],
      ['UPDATE users SET is_admin = 1', 'sql_not_select'],
      ['INSERT INTO users (id) VALUES (\'x\')', 'sql_not_select'],
      ['DROP TABLE users', 'sql_not_select'],
      ['PRAGMA writable_schema = 1', 'sql_not_select'],
      ['ATTACH DATABASE \'x.db\' AS other', 'sql_not_select'],
      ['SELECT 1; DELETE FROM users', 'sql_multiple_statements'],
      ['WITH x AS (SELECT 1) DELETE FROM users', 'sql_forbidden_keyword'],
      ['SELECT * FROM users WHERE id = ?', 'sql_parameters_unsupported'],
    ];
    for (const [sql, code] of attempts) {
      const response = await call('/api/admin/console/databases/primary/query', { method: 'POST', token: admin.token, body: { sql } });
      expect(response.status).toBe(400);
      const body = await response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe(code);
    }
    const after = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(Number(after!.n)).toBe(Number(before!.n));
    const rejected = await auditRows();
    expect(rejected.filter(row => row.status === 'rejected')).toHaveLength(attempts.length);
    // The audit stores a hash, never the statement text.
    for (const row of rejected) expect(row.sql_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exports bounded CSV with formula-safe cells and refuses oversized results', async () => {
    const admin = await seedUser(true);
    const response = await call('/api/admin/console/databases/primary/export', {
      method: 'POST', token: admin.token, body: { sql: "SELECT 'a,b' AS v, '=1+1' AS w" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="cflab-primary-');
    expect(await response.text()).toBe('v,w\r\n"a,b",\'=1+1\r\n');

    const large = await call('/api/admin/console/databases/primary/export', {
      method: 'POST', token: admin.token,
      body: { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2100) SELECT x FROM c' },
    });
    expect(large.status).toBe(413);
    expect((await large.json<{ error: { code: string } }>()).error.code).toBe('export_too_large');
  });
});


describe('saved statements', () => {
  it('keeps each administrator statements private and validates them at save time', async () => {
    const first = await seedUser(true);
    const second = await seedUser(true);
    const save = await call('/api/admin/console/saved-queries', {
      method: 'POST', token: first.token,
      body: { name: 'Recent users', database_id: 'primary', sql: 'SELECT email FROM users ORDER BY created_at DESC' },
    });
    expect(save.status).toBe(201);
    const saved = await save.json<{ id: string; name: string; database_id: string }>();
    expect(saved).toMatchObject({ name: 'Recent users', database_id: 'primary' });

    const mine = await (await call('/api/admin/console/saved-queries', { token: first.token })).json<{ queries: { id: string }[] }>();
    expect(mine.queries.map(query => query.id)).toEqual([saved.id]);
    const others = await (await call('/api/admin/console/saved-queries', { token: second.token })).json<{ queries: unknown[] }>();
    expect(others.queries).toEqual([]);
    expect((await call(`/api/admin/console/saved-queries/${saved.id}`, { method: 'DELETE', token: second.token })).status).toBe(404);

    const write = await call('/api/admin/console/saved-queries', {
      method: 'POST', token: first.token, body: { name: 'bad', database_id: 'primary', sql: 'DELETE FROM users' },
    });
    expect(write.status).toBe(400);
    const unknown = await call('/api/admin/console/saved-queries', {
      method: 'POST', token: first.token, body: { name: 'bad', database_id: 'other', sql: 'SELECT 1' },
    });
    expect(unknown.status).toBe(404);
    expect((await call(`/api/admin/console/saved-queries/${saved.id}`, { method: 'DELETE', token: first.token })).status).toBe(204);
  });
});

describe('job observability', () => {
  it('reports schedules, history and honest gaps for every registered job', async () => {
    const admin = await seedUser(true);
    const body = await (await call('/api/admin/console/jobs', { token: admin.token })).json<{
      jobs: { id: string; schedule: string; next_run_at: string | null; last_attempt: unknown; last_success_at: string | null;
        history: string; stale: boolean; warnings: string[] }[];
    }>();
    expect(body.jobs).toHaveLength(4);
    const hourly = body.jobs.find(job => job.id === 'signals-hourly')!;
    expect(hourly.history).toBe('recorded');
    expect(hourly.last_attempt).toBeNull();
    expect(hourly.last_success_at).toBeNull();
    expect(hourly.next_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:07:00\.000Z$/);
    expect(hourly.warnings).toContain('No successful run recorded');
    const analytics = body.jobs.find(job => job.id === 'analytics-maintenance')!;
    expect(analytics.history).toBe('recorded');
    expect(analytics.next_run_at).toMatch(/:17:00\.000Z$/);
    const backup = body.jobs.find(job => job.id === 'backup-workflow')!;
    expect(backup.history).toBe('external');
    expect(backup.next_run_at).toMatch(/:37:00\.000Z$/);
  });

  it('reads real Signals cron history and flags the latest failed attempt', async () => {
    const admin = await seedUser(true);
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    await bindings.BTC_SIGNALS.batch([
      bindings.BTC_SIGNALS.prepare(
        `INSERT INTO bs_collection_runs (id, job, trigger, started_at, finished_at, status, sources_total, sources_ok, observations_added)
         VALUES ('console-test-ok', 'hourly', 'cron', ?, ?, 'ok', 5, 5, 12)`)
        .bind(recent, new Date(Date.parse(recent) + 2000).toISOString()),
      bindings.BTC_SIGNALS.prepare(
        `INSERT INTO bs_collection_runs (id, job, trigger, started_at, finished_at, status, sources_total, sources_failed, detail)
         VALUES ('console-test-daily', 'daily', 'cron', ?, ?, 'failed', 1, 1, '1 of 1 source(s) failed')`)
        .bind(new Date(Date.parse(recent) + 60_000).toISOString(), new Date(Date.parse(recent) + 61_000).toISOString()),
    ]);
    const body = await (await call('/api/admin/console/jobs', { token: admin.token })).json<{
      jobs: { id: string; last_attempt: { status: string } | null; last_success_at: string | null; stale: boolean; warnings: string[] }[];
    }>();
    const hourly = body.jobs.find(job => job.id === 'signals-hourly')!;
    expect(hourly.last_success_at).toBe(recent);
    expect(hourly.stale).toBe(false);
    const daily = body.jobs.find(job => job.id === 'signals-daily')!;
    expect(daily.last_attempt?.status).toBe('failed');
    expect(daily.warnings).toContain('Last attempt failed');
  });
});


describe('system view', () => {
  it('reports binding presence without any value, and the recorded backup state', async () => {
    const admin = await seedUser(true);
    const response = await call('/api/admin/console/system', { token: admin.token });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(DEMO_KEY);
    const body = JSON.parse(text) as {
      revision: string; bindings: { name: string; configured: boolean }[];
      databases: { id: string }[]; backup: { recorded: boolean; ok: boolean | null };
    };
    expect(body.revision).toBe('unknown');
    expect(body.bindings.find(binding => binding.name === 'DB')?.configured).toBe(true);
    expect(body.bindings.find(binding => binding.name === 'COINGECKO_DEMO_API_KEY')?.configured).toBe(true);
    expect(body.databases).toHaveLength(3);
    expect(body.backup).toMatchObject({ recorded: false, ok: null });

    const now = new Date().toISOString();
    await bindings.BTC_SIGNALS.prepare(
      `INSERT INTO bs_backup_checks (id, checked_at, source, max_age_hours, ok, report_json, recorded_at, recorded_by_user_id)
       VALUES ('console-backup', ?, 'console-test', 30, 1, '{"ok":true}', ?, ?)`)
      .bind(now, now, admin.id).run();
    const after = await (await call('/api/admin/console/system', { token: admin.token })).json<{
      backup: { recorded: boolean; ok: boolean | null; stale: boolean };
    }>();
    expect(after.backup).toMatchObject({ recorded: true, ok: true, stale: false });

    // The overview stops warning about a missing attestation once one exists.
    const overview = await (await call('/api/admin/console/overview', { token: admin.token })).json<{ warnings: { area: string }[] }>();
    expect(overview.warnings.filter(warning => warning.area === 'backup')).toEqual([]);
  });
});

