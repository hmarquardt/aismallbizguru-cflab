import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import production from '../../src/index';
import type { Bindings } from '../../src/types';
import { createSession } from '../../src/auth/human';
import { BITCOIN_SIGNALS } from '../../src/projects';

const bindings = env as unknown as Bindings & {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  TEST_SIGNALS_MIGRATIONS: { name: string; queries: string[] }[];
};
const base = 'https://cflab.aismallbizguru.com';
const MACHINE_TOKEN = `cfl_${'a'.repeat(64)}`;

interface SeededUser { id: string; token: string }

async function seedUser({ admin = false, access, owner = false }: { admin?: boolean; access?: 'read' | 'write'; owner?: boolean } = {}): Promise<SeededUser> {
  const id = owner ? BITCOIN_SIGNALS.ownerUserId : crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)")
    .bind(id, `user-${id.slice(0, 8)}@example.com`, admin ? 1 : 0, now, now).run();
  if (access) {
    await bindings.DB.prepare("INSERT INTO project_memberships (user_id, app_id, access, created_at) VALUES (?, 'bitcoin-signals', ?, ?)")
      .bind(id, access, now).run();
  }
  const session = await createSession(bindings, id);
  return { id, token: session.token };
}

async function seedOwner(): Promise<SeededUser> { return seedUser({ admin: true, owner: true }); }

async function call(path: string, { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return await production.fetch(new Request(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), bindings);
}

async function json<T>(response: Response): Promise<T> { return await response.json<T>(); }

const EVIDENCE = {
  kind: 'settlement', title: 'Two states document a bitcoin settlement pilot',
  summary: 'A joint statement describes a pilot for cross-border settlement in bitcoin.',
  occurred_at: '2026-10-01T00:00:00.000Z', status: 'pilot', direction: 'supports', importance: 'high',
  source_title: 'Joint statement', source_url: 'https://example.gov/joint-statement',
  hypotheses: [{ id: 'sovereign-downstream', effect: 'supports' }],
};

async function seedObservation(series: string, value: number, at: string, venue = 'okx'): Promise<void> {
  await bindings.BTC_SIGNALS.prepare(
    `INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, revision, run_id, meta_json)
     VALUES ('curated-research', 'https://research.example.test/synthetic-fixture', ?, ?, ?, ?, ?, 'unit', 'definition', 'measured', 1, 'seed', '{}')`)
    .bind(series, venue, at, at, value).run();
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(bindings.BTC_SIGNALS, bindings.TEST_SIGNALS_MIGRATIONS);
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM project_memberships'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM password_reset_tokens'),
    bindings.DB.prepare('DELETE FROM users'),
  ]);
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
  ]);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('access control', () => {
  it('denies deactivated projects and deactivated or demoted owner accounts', async () => {
    const owner = await seedOwner();
    await bindings.DB.prepare("UPDATE apps SET active = 0 WHERE id = 'bitcoin-signals'").run();
    try {
      expect((await call('/api/bitcoin-signals/radar', { token: owner.token })).status).toBe(404);
    } finally {
      await bindings.DB.prepare("UPDATE apps SET active = 1 WHERE id = 'bitcoin-signals'").run();
    }
    await bindings.DB.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').bind(owner.id).run();
    expect((await call('/api/bitcoin-signals/radar', { token: owner.token })).status).toBe(403);
    await bindings.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(owner.id).run();
    expect((await call('/api/bitcoin-signals/radar', { token: owner.token })).status).toBe(401);
  });

  it('requires a human session and never accepts a machine token', async () => {
    expect((await call('/api/bitcoin-signals/radar')).status).toBe(401);
    expect((await call('/api/bitcoin-signals/radar', { token: MACHINE_TOKEN })).status).toBe(401);
    expect((await call('/api/bitcoin-signals/radar', { token: `cflu_${'b'.repeat(64)}` })).status).toBe(401);
  });

  it('rejects a signed-in user with no membership in the project', async () => {
    const stranger = await seedUser();
    expect((await call('/api/bitcoin-signals/radar', { token: stranger.token })).status).toBe(403);
  });

  it('allows the owner without a membership and denies read/write members', async () => {
    const owner = await seedOwner();
    const reader = await seedUser({ access: 'read' });
    const writer = await seedUser({ access: 'write' });
    const response = await call('/api/bitcoin-signals/radar', { token: owner.token });
    expect(response.status).toBe(200);
    expect((await json<{ caller: { access: string; is_admin: boolean } }>(response)).caller)
      .toMatchObject({ access: 'write', is_admin: true });
    expect((await call('/api/bitcoin-signals/settings', { token: owner.token })).status).toBe(200);
    for (const user of [reader, writer]) {
      for (const path of ['radar', 'arbitrage', 'evidence', 'settings', 'status', 'export?dataset=observations']) {
        expect((await call(`/api/bitcoin-signals/${path}`, { token: user.token })).status).toBe(403);
      }
      expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: EVIDENCE, token: user.token })).status).toBe(403);
    }
  });

  it('cannot be bypassed by a second administrator granting ordinary memberships', async () => {
    const owner = await seedOwner();
    const second = await seedUser({ admin: true });
    const member = await seedUser();
    for (const user of [second, member]) {
      for (const access of ['read', 'write']) {
        expect((await call(`/api/admin/users/${user.id}/memberships`, {
          method: 'POST', token: second.token, body: { app_id: 'bitcoin-signals', access },
        })).status).toBe(200);
        expect((await call('/api/apps/bitcoin-signals/resources/market/records', { token: user.token })).status).toBe(403);
        for (const path of ['radar', 'arbitrage', 'evidence', 'settings', 'status', 'export?dataset=evidence']) {
          expect((await call(`/api/bitcoin-signals/${path}`, { token: user.token })).status).toBe(403);
        }
        expect((await call('/api/bitcoin-signals/refresh', { method: 'POST', token: user.token, body: { scope: 'all' } })).status).toBe(403);
        expect((await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: user.token, body: { notifications: { enabled: true, email_to: 'offline@example.test' } } })).status).toBe(403);
        expect((await call('/api/bitcoin-signals/backup-attestation', { method: 'POST', token: user.token, body: {} })).status).toBe(403);
        expect((await call('/api/admin/projects/bitcoin-signals/status', { token: second.token })).status).toBe(403);
      }
    }
    expect((await call('/api/bitcoin-signals/radar', { token: owner.token })).status).toBe(200);
    expect((await call('/api/admin/projects/bitcoin-signals/status', { token: owner.token })).status).toBe(200);
    expect((await bindings.BTC_SIGNALS.prepare("SELECT value_json FROM bs_settings WHERE key='alerts.notifications'").first<{value_json:string}>())!.value_json).toContain('"enabled":false');
    expect(Number((await bindings.BTC_SIGNALS.prepare('SELECT COUNT(*) n FROM bs_collection_runs').first<{n:number}>())!.n)).toBe(0);
  });

  it('keeps second-admin CFLab privileges while withholding Signals research status', async () => {
    const second = await seedUser({ admin: true });
    expect((await call('/api/admin/users', { token: second.token })).status).toBe(200);
    for (const path of ['/api/admin/apps', '/api/admin/projects', '/api/admin/apps/top-hat-ferals', '/api/admin/projects/top-hat-ferals/status']) {
      expect((await call(path, { token: second.token })).status).toBe(200);
    }
    const denied = await call('/api/admin/projects/bitcoin-signals/status', { token: second.token });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toMatch(/observations|source_id|collection|alerts_open|funding/);
    expect((await call('/api/admin/apps/top-hat-ferals', { method: 'PATCH', token: second.token, body: { name: 'Top Hat Ferals' } })).status).toBe(200);
  });

  it('blocks valid machine tokens and non-owner sessions on generic Signals data routes', async () => {
    const owner = await seedOwner();
    const second = await seedUser({ admin: true });
    const issued = await call('/api/admin/apps/bitcoin-signals/tokens', {
      method: 'POST', token: second.token, body: { name: 'offline regression only', scopes: ['records:read'] },
    });
    expect(issued.status).toBe(201);
    const machine = await json<{ token: string }>(issued);
    for (const path of ['/api/apps/bitcoin-signals', '/api/apps/bitcoin-signals/resources/market/records',
      '/api/apps/bitcoin-signals/files', '/api/apps/bitcoin-signals/proxy/test']) {
      expect((await call(path, { token: second.token })).status).toBe(403);
      expect((await call(path, { token: machine.token })).status).toBe(401);
    }
    expect((await call('/api/bitcoin-signals/radar', { token: machine.token })).status).toBe(401);
    expect((await call('/api/apps/bitcoin-signals', { token: owner.token })).status).toBe(200);
    expect((await call('/api/apps/top-hat-ferals', { token: second.token })).status).toBe(200);
  });

  it('ignores mutable project ownership claims and forged membership or identity headers', async () => {
    const owner = await seedOwner();
    const second = await seedUser({ admin: true, access: 'write' });
    const saved = await bindings.DB.prepare("SELECT config_json FROM apps WHERE id='bitcoin-signals'").first<{config_json:string}>();
    try {
      expect((await call('/api/admin/apps/bitcoin-signals', { method: 'PATCH', token: second.token,
        body: { config: { ownerUserId: second.id, owner: second.id, is_admin: true, private: false } } })).status).toBe(200);
      const response = await production.fetch(new Request(`${base}/api/bitcoin-signals/radar`, {
        headers: { Authorization: `Bearer ${second.token}`, 'X-User-Id': owner.id, 'X-Admin': 'true', 'X-Project-Access': 'write' },
      }), bindings);
      expect(response.status).toBe(403);
      expect((await call('/api/bitcoin-signals/radar', { token: owner.token })).status).toBe(200);
    } finally {
      await bindings.DB.prepare("UPDATE apps SET config_json=? WHERE id='bitcoin-signals'").bind(saved!.config_json).run();
    }
  });

});

describe('evidence provenance and review', () => {
  it('counts the effect on each hypothesis rather than the overall evidence direction', async () => {
    const writer = await seedOwner();
    await call('/api/bitcoin-signals/evidence', { method: 'POST', token: writer.token,
      body: { ...EVIDENCE, hypotheses: [{ id: 'sovereign-downstream', effect: 'contradicts' }] } });
    const radar = await json<{ hypotheses: { id: string; evidence: { supports: number; contradicts: number } }[] }>(await call('/api/bitcoin-signals/radar', { token: writer.token }));
    expect(radar.hypotheses.find(row => row.id === 'sovereign-downstream')?.evidence).toMatchObject({ supports: 0, contradicts: 1 });
  });

  it('validates the entire evidence patch before saving a summary', async () => {
    const writer = await seedOwner();
    const created = await json<{ evidence: { id: string } }>(await call('/api/bitcoin-signals/evidence', { method: 'POST', token: writer.token, body: EVIDENCE }));
    const response = await call(`/api/bitcoin-signals/evidence/${created.evidence.id}`, { method: 'PATCH', token: writer.token,
      body: { summary: 'must not be saved', review_status: 'invalid' } });
    expect(response.status).toBe(400);
    const row = await bindings.BTC_SIGNALS.prepare('SELECT summary FROM bs_evidence WHERE id = ?').bind(created.evidence.id).first<{ summary: string }>();
    expect(row?.summary).toBe(EVIDENCE.summary);
  });
  it('retains source, timestamps, and review attribution', async () => {
    const writer = await seedOwner();
    const created = await call('/api/bitcoin-signals/evidence', { method: 'POST', body: EVIDENCE, token: writer.token });
    expect(created.status).toBe(201);
    const createdBody = await json<{ evidence: { id: string; retrieved_at: string; source_url: string } }>(created);
    const stored = await bindings.BTC_SIGNALS.prepare('SELECT * FROM bs_evidence WHERE id = ?')
      .bind(createdBody.evidence.id).first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      kind: 'settlement', status: 'pilot', direction: 'supports', importance: 'high',
      source_title: 'Joint statement', source_url: 'https://example.gov/joint-statement',
      occurred_at: '2026-10-01T00:00:00.000Z', review_status: 'unreviewed',
    });
    expect(typeof stored!.retrieved_at).toBe('string');
    expect(Number.isFinite(Date.parse(String(stored!.retrieved_at)))).toBe(true);
    expect(typeof stored!.fingerprint).toBe('string');
    const links = await bindings.BTC_SIGNALS.prepare('SELECT hypothesis_id, effect FROM bs_evidence_hypotheses WHERE evidence_id = ?')
      .bind(createdBody.evidence.id).all<{ hypothesis_id: string; effect: string }>();
    expect(links.results).toEqual([{ hypothesis_id: 'sovereign-downstream', effect: 'supports' }]);

    const review = await call(`/api/bitcoin-signals/evidence/${createdBody.evidence.id}`, { method: 'PATCH', body: { review_status: 'verified' }, token: writer.token });
    expect(review.status).toBe(200);
    const reviewed = await bindings.BTC_SIGNALS.prepare('SELECT review_status, reviewed_by_user_id, reviewed_at FROM bs_evidence WHERE id = ?')
      .bind(createdBody.evidence.id).first<{ review_status: string; reviewed_by_user_id: string; reviewed_at: string }>();
    expect(reviewed).toMatchObject({ review_status: 'verified', reviewed_by_user_id: writer.id });
    expect(Number.isFinite(Date.parse(reviewed!.reviewed_at))).toBe(true);
    // A verified, important development raises exactly one alert.
    const alert = await bindings.BTC_SIGNALS.prepare("SELECT rule_id, dedupe_key FROM bs_alerts WHERE rule_id = 'verified-development'")
      .all<{ rule_id: string; dedupe_key: string }>();
    expect(alert.results).toEqual([{ rule_id: 'verified-development', dedupe_key: createdBody.evidence.id }]);
  });

  it('rejects a duplicate entry, an invalid URL, and unknown hypotheses', async () => {
    const writer = await seedOwner();
    expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: EVIDENCE, token: writer.token })).status).toBe(201);
    expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: EVIDENCE, token: writer.token })).status).toBe(409);
    expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: { ...EVIDENCE, title: 'Another', source_url: 'http://example.gov/x' }, token: writer.token })).status).toBe(400);
    expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: { ...EVIDENCE, title: 'Third', hypotheses: [{ id: 'invented', effect: 'supports' }] }, token: writer.token })).status).toBe(400);
    expect((await call('/api/bitcoin-signals/evidence', { method: 'POST', body: { ...EVIDENCE, title: 'Fourth', occurred_at: '2999-01-01T00:00:00.000Z' }, token: writer.token })).status).toBe(400);
  });

  it('searches and filters without becoming a SQL surface', async () => {
    const writer = await seedOwner();
    await call('/api/bitcoin-signals/evidence', { method: 'POST', body: EVIDENCE, token: writer.token });
    await call('/api/bitcoin-signals/evidence', {
      method: 'POST', token: writer.token,
      body: { ...EVIDENCE, kind: 'regulation', title: 'A regulator publishes final payment rules', status: 'effective', direction: 'mixed', importance: 'normal', source_url: 'https://example.gov/rules', hypotheses: [] },
    });
    const all = await json<{ items: { title: string }[]; total: number }>(await call('/api/bitcoin-signals/evidence', { token: writer.token }));
    expect(all.total).toBe(2);
    const searched = await json<{ items: { title: string }[]; total: number }>(await call('/api/bitcoin-signals/evidence?q=regulator', { token: writer.token }));
    expect(searched.total).toBe(1);
    expect(searched.items[0]!.title).toContain('regulator');
    const filtered = await json<{ total: number }>(await call('/api/bitcoin-signals/evidence?kind=settlement&status=pilot', { token: writer.token }));
    expect(filtered.total).toBe(1);
    // LIKE wildcards in the search string are literal, and SQL is never injected.
    const wildcard = await json<{ total: number }>(await call('/api/bitcoin-signals/evidence?q=%25', { token: writer.token }));
    expect(wildcard.total).toBe(0);
    expect((await call('/api/bitcoin-signals/evidence?limit=1%27%20OR%201%3D1--', { token: writer.token })).status).toBe(400);
  });
});

describe('storage separation', () => {
  it('keeps project data out of the primary and analytics databases', async () => {
    const tables = async (db: D1Database) => (await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'bs\\_%' ESCAPE '\\' ORDER BY name").all<{ name: string }>()).results.map(row => row.name);
    expect(await tables(bindings.DB)).toEqual([]);
    expect(await tables(bindings.ANALYTICS)).toEqual([]);
    const signalsTables = await tables(bindings.BTC_SIGNALS);
    expect(signalsTables).toContain('bs_observations');
    expect(signalsTables).toContain('bs_evidence');
    // The project data database holds no identity tables either.
    const identity = await bindings.BTC_SIGNALS.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'sessions', 'apps', 'project_memberships')").first<{ n: number }>();
    expect(Number(identity!.n)).toBe(0);
  });

  it('registers Bitcoin Signals as a first-class project with its own backend', async () => {
    const registry = await bindings.DB.prepare("SELECT backend, binding, migrations_dir FROM project_storage WHERE app_id = 'bitcoin-signals'")
      .first<{ backend: string; binding: string; migrations_dir: string }>();
    expect(registry).toEqual({ backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', migrations_dir: 'migrations-bitcoin-signals' });
    const app = await bindings.DB.prepare("SELECT name, active FROM apps WHERE id = 'bitcoin-signals'").first<{ name: string; active: number }>();
    expect(app).toEqual({ name: 'Bitcoin Signals', active: 1 });
  });

  it('reads observations only from the assigned database', async () => {
    const admin = await seedOwner();
    await seedObservation('spot_price_usd', 80_123.45, '2026-10-25T12:00:00.000Z', 'coinbase');
    const radar = await json<{ indicators: { series: string; venue: string; value: number }[] }>(await call('/api/bitcoin-signals/radar', { token: admin.token }));
    const spot = radar.indicators.find(indicator => indicator.series === 'spot_price_usd' && indicator.venue === 'coinbase');
    expect(spot?.value).toBeCloseTo(80_123.45, 6);
    // Nothing was written to the primary database.
    const primary = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'bs_%'").first<{ n: number }>();
    expect(Number(primary!.n)).toBe(0);
  });
});

describe('dashboard page', () => {
  it('serves an empty authenticated shell with the four sections and no external assets', async () => {
    const response = await call('/bitcoin-signals');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    for (const section of ['panel-radar', 'panel-arbitrage', 'panel-evidence', 'panel-settings']) {
      expect(html).toContain(section);
    }
    expect(html).toContain('width=device-width');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?!cflab\.aismallbizguru\.com|www\.coingecko\.com\/en\/api")/);
    expect(html).toContain('href="https://www.coingecko.com/en/api" rel="noreferrer noopener" target="_blank">Powered by CoinGecko</a>');
    // The shell carries no measurements: every figure is fetched with a session.
    expect(html).not.toContain('spot_price_usd');
    expect(html).not.toContain('treasury_total_btc');
  });
});

describe('CFLab administration screens', () => {
  it('show the project storage registry and link to the dashboard', async () => {
    const page = await call('/admin/users');
    expect(page.status).toBe(200);
    const html = await page.text();
    // The existing users screen gains a project/storage panel and a nav link; the
    // Bitcoin Signals health panel is populated from /api/admin/projects/... .
    expect(html).toContain('Projects and storage');
    expect(html).toContain('id="projects"');
    expect(html).toContain('id="signals-health"');
    expect(html).toContain('href="/bitcoin-signals"');
    expect(html).toContain('/api/admin/projects');
  });
});

describe('arbitrage calculations through the API', () => {
  it('does not invent cumulative income from sampled quotes', async () => {
    const admin = await seedOwner();
    await seedObservation('funding_current_8h', 0.0001, new Date(Date.now() - 30 * 60_000).toISOString());
    const view = await json<{ venues: { persistence: { basis: string; cumulative_pct: number | null } }[] }>(await call('/api/bitcoin-signals/arbitrage', { token: admin.token }));
    expect(view.venues[0]?.persistence).toMatchObject({ basis: 'sampled', cumulative_pct: null });
  });
  it('computes normalized funding, carry after costs, basis, and persistence', async () => {
    const admin = await seedOwner();
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    await seedObservation('funding_current_8h', 0.0005, at, 'okx');
    await seedObservation('index_price_usd', 80_000, at, 'okx');
    await seedObservation('perp_mark_price_usd', 80_010, at, 'okx');
    for (let index = 1; index <= 6; index += 1) {
      await seedObservation('funding_settled_8h', index % 2 === 0 ? -0.0001 : 0.0002, new Date(Date.parse(at) - index * 8 * 3_600_000).toISOString(), 'okx');
    }
    await bindings.BTC_SIGNALS.prepare(
      `INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, revision, run_id, meta_json)
       VALUES ('curated-research', 'https://research.example.test/synthetic-fixture', 'dated_future_mark_usd', 'deribit:BTC-27NOV26', ?, ?, ?, 'USD per BTC', 'definition', 'measured', 1, 'seed', ?)`)
      .bind(at, at, 81_600, JSON.stringify({ family: 'deribit', instrument: 'BTC-27NOV26', expiry: new Date(Date.now() + 30 * 86_400_000).toISOString(), index_usd: 80_000 })).run();

    const view = await json<{
      assumptions: { feeBpsPerLeg: number; legs: number };
      venues: { venue: string; funding_8h_pct: number; carry: { net_apr_pct: number; cost_pct: number } | null; persistence: { basis: string; positive_share: number; samples: number } }[];
      basis: { instrument: string; basis_pct: number; net_annualized_pct: number; cost_apr_pct: number; days_to_expiry: number }[];
      best_funding: { venue: string } | null;
      disclaimer: string;
    }>(await call('/api/bitcoin-signals/arbitrage', { token: admin.token }));
    const okx = view.venues.find(venue => venue.venue === 'okx')!;
    expect(okx.funding_8h_pct).toBeCloseTo(0.05, 10);
    expect(view.assumptions).toMatchObject({ feeBpsPerLeg: 2, legs: 4 });
    expect(okx.carry!.cost_pct).toBeCloseTo(0.12, 8);
    // 0.0005 * 1095 = 54.75% APR gross; costs 1.46% APR over 30 days.
    expect(okx.carry!.net_apr_pct).toBeCloseTo(54.75 - 1.46, 6);
    expect(okx.persistence.basis).toBe('settled');
    expect(okx.persistence.samples).toBe(6);
    expect(okx.persistence.positive_share).toBeCloseTo(0.5, 6);
    const basis = view.basis[0]!;
    expect(basis.basis_pct).toBeCloseTo(2, 6);
    expect(basis.net_annualized_pct).toBeLessThan(basis.basis_pct * (365 / 30));
    expect(basis.cost_apr_pct).toBeCloseTo(0.12 * 365 / (30 + 0.5 / 24), 5);
    expect(view.best_funding?.venue).toBe('okx');
    expect(view.disclaimer).toMatch(/not guaranteed income/i);
  });

  it('honours operator assumptions in the query without storing them', async () => {
    const admin = await seedOwner();
    await seedObservation('funding_current_8h', 0.0001, new Date(Date.now() - 30 * 60_000).toISOString(), 'okx');
    const cheap = await json<{ venues: { carry: { net_apr_pct: number } }[] }>(await call('/api/bitcoin-signals/arbitrage?fee_bps=0&slippage_bps=0&legs=2&holding_days=1', { token: admin.token }));
    const expensive = await json<{ venues: { carry: { net_apr_pct: number } }[] }>(await call('/api/bitcoin-signals/arbitrage?fee_bps=50&slippage_bps=50&legs=4&holding_days=1', { token: admin.token }));
    expect(cheap.venues[0]!.carry.net_apr_pct).toBeGreaterThan(expensive.venues[0]!.carry.net_apr_pct);
    expect(expensive.venues[0]!.carry.net_apr_pct).toBeLessThan(0);
    expect((await call('/api/bitcoin-signals/arbitrage?holding_days=0', { token: admin.token })).status).toBe(400);
    expect((await call('/api/bitcoin-signals/arbitrage?fee_bps=2&fee_bps=3', { token: admin.token })).status).toBe(400);
  });
});

describe('operator settings, refresh, backup, and export', () => {
  it('rejects the entire settings patch before enabling notifications if another field is invalid', async () => {
    const admin = await seedOwner();
    const response = await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token,
      body: { notifications: { enabled: true, email_to: 'research@example.com' }, assumptions: { legs: 0 } } });
    expect(response.status).toBe(400);
    const settings = await json<{ notifications: { enabled: boolean } }>(await call('/api/bitcoin-signals/settings', { token: admin.token }));
    expect(settings.notifications.enabled).toBe(false);
  });

  it('expires an attestation when the actual backups age out', async () => {
    const admin = await seedOwner();
    const capturedAt = new Date(Date.now() - 29 * 3_600_000).toISOString();
    const report = ['cflab', 'cflab-analytics', 'cflab-bitcoin-signals'].map(database => ({ database, status: 'fresh', captured_at: capturedAt }));
    const response = await call('/api/bitcoin-signals/backup-attestation', { method: 'POST', token: admin.token, body: { max_age_hours: 30, report } });
    expect(response.status).toBe(200);
    expect((await response.json<{ ok: boolean }>()).ok).toBe(true);
    const { backupView } = await import('../../src/bitcoin-signals/queries');
    expect((await backupView(bindings.BTC_SIGNALS, new Date(Date.now() + 2 * 3_600_000))).ok).toBe(false);
  });
  it('keeps notifications off by default and validates any change', async () => {
    const admin = await seedOwner();
    const initial = await json<{ notifications: { enabled: boolean } }>(await call('/api/bitcoin-signals/settings', { token: admin.token }));
    expect(initial.notifications.enabled).toBe(false);
    const noRecipient = await call('/api/bitcoin-signals/settings', {
      method: 'PATCH', token: admin.token,
      body: { notifications: { enabled: true, email_to: '' } },
    });
    expect(noRecipient.status).toBe(400);
    const enabled = await call('/api/bitcoin-signals/settings', {
      method: 'PATCH', token: admin.token,
      body: { notifications: { enabled: true, email_to: 'Research@Example.com' }, rules: { funding_threshold_bps_8h: 7 } },
    });
    expect(enabled.status).toBe(200);
    const stored = await bindings.BTC_SIGNALS.prepare("SELECT value_json FROM bs_settings WHERE key = 'alerts.notifications'").first<{ value_json: string }>();
    expect(JSON.parse(stored!.value_json)).toEqual({ enabled: true, email_to: 'research@example.com' });
    // A partial update keeps the thresholds that were already configured.
    const partial = await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token, body: { rules: { treasury_change_btc: 500 } } });
    expect(partial.status).toBe(200);
    const mergedRules = await json<{ rules: { funding_threshold_bps_8h: number; treasury_change_btc: number; funding_sustained_periods: number } }>(partial);
    expect(mergedRules.rules).toMatchObject({ funding_threshold_bps_8h: 7, treasury_change_btc: 500, funding_sustained_periods: 6 });
    const partialNotifications = await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token, body: { notifications: { email_to: 'second@example.com' } } });
    expect(partialNotifications.status).toBe(200);
    expect(await json<{ notifications: { enabled: boolean; email_to: string } }>(partialNotifications)).toMatchObject({ notifications: { enabled: true, email_to: 'second@example.com' } });
    const badRule = await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token, body: { rules: { funding_sustained_periods: 0 } } });
    expect(badRule.status).toBe(400);
    const badAssumption = await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token, body: { assumptions: { leverage: 10 } } });
    expect(badAssumption.status).toBe(400);
    expect((await call('/api/bitcoin-signals/settings', { method: 'PATCH', token: admin.token, body: {} })).status).toBe(400);
  });

  it('runs an administrator refresh and records the outcome, even when every source fails', async () => {
    const admin = await seedOwner();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })));
    const response = await call('/api/bitcoin-signals/refresh', { method: 'POST', body: { scope: 'hourly' }, token: admin.token });
    expect(response.status).toBe(200);
    const body = await json<{ runs: { status: string; job: string; sources: { status: string }[] }[] }>(response);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]!.job).toBe('hourly');
    expect(body.runs[0]!.status).toBe('failed');
    expect(body.runs[0]!.sources.every(source => source.status === 'failed')).toBe(true);
    const runs = await bindings.BTC_SIGNALS.prepare("SELECT job, trigger, status FROM bs_collection_runs WHERE job = 'manual'")
      .all<{ job: string; trigger: string; status: string }>();
    expect(runs.results).toEqual([{ job: 'manual', trigger: 'manual', status: 'failed' }]);
  });

  it('rejects an unvalidated backup attestation and records a complete one', async () => {
    const admin = await seedOwner();
    const incomplete = await call('/api/bitcoin-signals/backup-attestation', {
      method: 'POST', token: admin.token,
      body: { ok: true, max_age_hours: 30, report: [{ database: 'cflab', status: 'fresh' }] },
    });
    expect(incomplete.status).toBe(400);
    expect((await call('/api/bitcoin-signals/backup-attestation', { method: 'POST', token: admin.token, body: { ok: true, max_age_hours: 0, report: [] } })).status).toBe(400);

    const report = [
      { database: 'cflab', status: 'fresh', age_hours: 4 },
      { database: 'cflab-analytics', status: 'fresh', age_hours: 4 },
      { database: 'cflab-bitcoin-signals', status: 'stale', age_hours: 40 },
    ];
    // A claimed ok flag cannot make a stale database fresh.
    const recorded = await json<{ ok: boolean }>(await call('/api/bitcoin-signals/backup-attestation', {
      method: 'POST', token: admin.token, body: { ok: true, max_age_hours: 30, report },
    }));
    expect(recorded.ok).toBe(false);
    const status = await json<{ backup: { recorded: boolean; ok: boolean }; backups_expected: { databases: string[] } }>(await call('/api/bitcoin-signals/status', { token: admin.token }));
    expect(status.backup).toMatchObject({ recorded: true, ok: false });
    expect(status.backups_expected.databases).toEqual(['cflab', 'cflab-analytics', 'cflab-bitcoin-signals']);
  });

  it('exports bounded CSV and rejects an unknown dataset', async () => {
    const admin = await seedOwner();
    await seedObservation('spot_price_usd', 80_000, new Date(Date.now() - 60_000).toISOString(), 'coinbase');
    const observations = await call('/api/bitcoin-signals/export?dataset=observations&series=spot_price_usd', { token: admin.token });
    expect(observations.status).toBe(200);
    expect(observations.headers.get('content-type')).toContain('text/csv');
    expect(observations.headers.get('content-disposition')).toContain('bitcoin-signals-observations.csv');
    const csv = await observations.text();
    expect(csv.split('\n')[0]).toBe('source_id,source_url,series,venue,observed_at,retrieved_at,value,unit,tier,revision,run_id,meta_json');
    expect(csv).toContain('spot_price_usd');
    expect((await call('/api/bitcoin-signals/export?dataset=tables', { token: admin.token })).status).toBe(400);
    expect((await call('/api/bitcoin-signals/export?dataset=observations&series=users', { token: admin.token })).status).toBe(400);
  });
});

describe('CFLab administration integration', () => {
  it('lists the project with its storage backend and dashboard', async () => {
    const admin = await seedOwner();
    const projects = await json<{ projects: { id: string; storage: { backend: string; binding: string; migrations_dir: string }; dashboard: string | null }[] }>(
      await call('/api/admin/projects', { token: admin.token }));
    const signals = projects.projects.find(project => project.id === 'bitcoin-signals')!;
    expect(signals.storage).toMatchObject({ backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', migrations_dir: 'migrations-bitcoin-signals' });
    expect(signals.dashboard).toBe('/bitcoin-signals');
    const apps = await json<{ apps: { id: string; storage: { binding: string } }[] }>(await call('/api/admin/apps', { token: admin.token }));
    expect(apps.apps.find(app => app.id === 'bitcoin-signals')!.storage.binding).toBe('BTC_SIGNALS');
  });

  it('reports collection health, freshness, and backup status for the project', async () => {
    const admin = await seedOwner();
    const status = await json<{
      project: { storage: { backend: string; binding: string; reachable: boolean; registered: boolean } };
      collection: { sources: { source_id: string; cadence: string }[] };
      data: { observations: number };
      backup: { recorded: boolean };
    }>(await call('/api/admin/projects/bitcoin-signals/status', { token: admin.token }));
    expect(status.project.storage).toMatchObject({ backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', reachable: true, registered: true });
    expect(status.collection.sources.map(source => source.source_id)).toContain('okx');
    expect(status.collection.sources.map(source => source.source_id)).toContain('curated-research');
    expect(status.data.observations).toBe(0);
    expect(status.backup.recorded).toBe(false);
  });

  it('does not expose another project as a data browser', async () => {
    const admin = await seedOwner();
    await bindings.DB.prepare("INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('plain-app', 'Plain', 1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    const status = await json<{ project: { app_id: string; storage: { backend: string } }; data?: unknown; collection?: unknown }>(
      await call('/api/admin/projects/plain-app/status', { token: admin.token }));
    expect(status.project.app_id).toBe('plain-app');
    expect(status.project.storage.backend).toBe('primary');
    expect(status.data).toBeUndefined();
    expect((await call('/api/admin/projects/missing/status', { token: admin.token })).status).toBe(404);
    await bindings.DB.prepare("DELETE FROM apps WHERE id = 'plain-app'").run();
  });

  it('keeps the existing app and user administration unchanged', async () => {
    const admin = await seedOwner();
    const created = await call('/api/admin/apps', { method: 'POST', token: admin.token, body: { id: 'compat-app', name: 'Compat', origins: ['https://client.example'] } });
    expect(created.status).toBe(201);
    const listed = await json<{ apps: { id: string; storage: { binding: string }; storage_backend?: string }[] }>(await call('/api/admin/apps', { token: admin.token }));
    // Existing projects default to the primary backend and keep their shape.
    const compat = listed.apps.find(app => app.id === 'compat-app')!;
    expect(compat.storage.binding).toBe('DB');
    expect(compat.storage_backend).toBeUndefined();
    const users = await call('/api/admin/users', { token: admin.token });
    expect(users.status).toBe(200);
    await bindings.DB.prepare("DELETE FROM apps WHERE id = 'compat-app'").run();
  });
});

describe('radar change calculation', () => {
  it('retains a stale venue even when healthy venues have filled the scan limit', async () => {
    await seedObservation('spot_price_usd', 80_000, '2026-09-01T00:00:00.000Z', 'stopped');
    for (let batch = 0; batch < 11; batch++) {
      await bindings.BTC_SIGNALS.batch(Array.from({ length: 40 }, (_, i) => {
        const at = new Date(Date.parse('2026-10-25T00:00:00.000Z') - (batch * 40 + i) * 60_000).toISOString();
        return bindings.BTC_SIGNALS.prepare(`INSERT INTO bs_observations (source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, definition, tier, meta_json)
          VALUES ('curated-research', 'https://research.example.test/synthetic-fixture', 'spot_price_usd', 'healthy', ?, ?, 81000, 'USDT per BTC', 'test', 'measured', '{}')`).bind(at, at);
      }));
    }
    const { latestByVenue, csvEscape } = await import('../../src/bitcoin-signals/queries');
    expect((await latestByVenue(bindings.BTC_SIGNALS, 'spot_price_usd')).map(row => row.venue)).toContain('stopped');
    expect(csvEscape('=HYPERLINK("https://evil.test")')).toMatch(/^"'/);
    expect(csvEscape(-1)).toBe('-1');
  });
  it('compares against the point closest to seven days ago, not the oldest retained point', async () => {
    const { changeOverWeek } = await import('../../src/bitcoin-signals/queries');
    const day = 86_400_000;
    const last = Date.parse('2026-10-25T00:00:00.000Z');
    const daily: { at: string; value: number }[] = [];
    for (let index = 60; index >= 0; index -= 1) daily.push({ at: new Date(last - index * day).toISOString(), value: 100 });
    daily[daily.length - 8] = { at: new Date(last - 7 * day).toISOString(), value: 80 };
    daily[daily.length - 1] = { at: new Date(last).toISOString(), value: 100 };
    expect(changeOverWeek(daily)).toBeCloseTo(25, 10);
    expect(changeOverWeek(undefined)).toBeNull();
    expect(changeOverWeek([{ at: new Date(last).toISOString(), value: 1 }])).toBeNull();
    expect(changeOverWeek([{ at: new Date(last - day).toISOString(), value: 0 }, { at: new Date(last).toISOString(), value: 1 }])).toBeNull();
    expect(changeOverWeek([{ at: new Date(last - day).toISOString(), value: 1 }, { at: new Date(last).toISOString(), value: 2 }])).toBeNull();
  });
});
