// Overview, registry, and system views for the operations console.
//
// Every number here comes from a bounded aggregate over a database this Worker
// already binds. There is no universal discovery, no Cloudflare API credential,
// and no external network call on a dashboard request.

import type { Bindings } from '../types';
import { deploymentIdentity } from '../shared/revision';
import { databaseForBinding } from '../projects';
import { CONSOLE_DATABASES, databaseInventory, type DatabaseInventory } from './databases';
import { jobViews, type JobView } from './jobs';
import { BACKUP_FRESHNESS_HOURS } from '../bitcoin-signals/status';
import { collectionView, type CollectionView } from '../bitcoin-signals/queries';

export interface RegistryEndpoint { id: string; method: string; path: string; access: string; summary: string }
export interface RegistryResource { id: string; kind: string; reference: string; detail: string }
export interface RegistryService {
  id: string; name: string; kind: string; status: string; description: string;
  worker: string | null; base_url: string | null; dashboard_path: string | null;
  endpoints: RegistryEndpoint[]; resources: RegistryResource[];
}
export interface RegistryJob {
  id: string; service_id: string; name: string; schedule: string; description: string; active: boolean;
}
export interface RegistryView {
  generated_at: string;
  services: RegistryService[];
  repositories: { id: string; name: string; url: string; branch: string; detail: string }[];
  jobs: RegistryJob[];
  counts: { services: number; endpoints: number; resources: number; repositories: number; jobs: number };
}

export async function registryView(db: D1Database, now = new Date()): Promise<RegistryView> {
  const [services, endpoints, resources, repositories, jobs] = await Promise.all([
    db.prepare('SELECT id, name, kind, status, description, worker, base_url, dashboard_path FROM console_services ORDER BY kind, name')
      .all<Omit<RegistryService, 'endpoints' | 'resources'>>(),
    db.prepare('SELECT id, service_id, method, path, access, summary FROM console_endpoints ORDER BY service_id, path, method')
      .all<RegistryEndpoint & { service_id: string }>(),
    db.prepare('SELECT id, service_id, kind, reference, detail FROM console_resources ORDER BY service_id, kind, reference')
      .all<RegistryResource & { service_id: string }>(),
    db.prepare('SELECT id, name, url, branch, detail FROM console_repositories ORDER BY name').all<RegistryView['repositories'][number]>(),
    db.prepare('SELECT id, service_id, name, schedule, description, active FROM console_jobs ORDER BY schedule, id')
      .all<Omit<RegistryJob, 'active'> & { active: number }>(),
  ]);

  const byService = new Map<string, RegistryService>();
  for (const row of services.results) byService.set(row.id, { ...row, endpoints: [], resources: [] });
  for (const row of endpoints.results) {
    const { service_id, ...endpoint } = row;
    byService.get(service_id)?.endpoints.push(endpoint);
  }
  for (const row of resources.results) {
    const { service_id, ...resource } = row;
    byService.get(service_id)?.resources.push(resource);
  }
  return {
    generated_at: now.toISOString(),
    services: [...byService.values()],
    repositories: repositories.results,
    jobs: jobs.results.map(({ active, ...job }) => ({ ...job, active: !!active })),
    counts: {
      services: services.results.length,
      endpoints: endpoints.results.length,
      resources: resources.results.length,
      repositories: repositories.results.length,
      jobs: jobs.results.length,
    },
  };
}

export interface Warning { severity: 'error' | 'warning' | 'info'; area: string; message: string }
export interface ActivityEntry { at: string; area: string; status: string; summary: string }

export interface ConsoleOverview {
  generated_at: string;
  caller: { email: string; is_admin: boolean };
  revision: string;
  summary: {
    projects: number; active_projects: number; users: number; administrators: number; sessions: number;
    analytics_sites: number; signals_observations: number | null; databases: number; jobs: number;
  };
  health: { databases: { id: string; label: string; reachable: boolean }[] };
  warnings: Warning[];
  activity: ActivityEntry[];
}

interface CountRow {
  projects: number; active_projects: number; users: number; administrators: number; sessions: number;
}

async function backupState(env: Bindings, now: Date): Promise<{
  recorded: boolean; checked_at: string | null; recorded_at: string | null; ok: boolean | null;
  max_age_hours: number; age_hours: number | null; stale: boolean;
}> {
  const empty = {
    recorded: false, checked_at: null, recorded_at: null, ok: null,
    max_age_hours: BACKUP_FRESHNESS_HOURS, age_hours: null, stale: true,
  };
  try {
    const row = await env.BTC_SIGNALS.prepare(
      'SELECT checked_at, recorded_at, ok, max_age_hours FROM bs_backup_checks ORDER BY checked_at DESC LIMIT 1')
      .first<{ checked_at: string; recorded_at: string; ok: number; max_age_hours: number }>();
    if (!row) return empty;
    const age = (now.getTime() - Date.parse(row.checked_at)) / 3_600_000;
    return {
      recorded: true, checked_at: row.checked_at, recorded_at: row.recorded_at, ok: !!row.ok,
      max_age_hours: row.max_age_hours, age_hours: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
      stale: !Number.isFinite(age) || age > row.max_age_hours,
    };
  } catch {
    return empty;
  }
}

export async function overviewView(
  env: Bindings, caller: { email: string; is_admin: boolean }, now = new Date(),
): Promise<ConsoleOverview> {
  const nowIso = now.toISOString();
  const [counts, recentSessions, signalsCount, analyticsSites, signalsCollection, jobs, backup] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM apps) AS projects,
              (SELECT COUNT(*) FROM apps WHERE active = 1) AS active_projects,
              (SELECT COUNT(*) FROM users WHERE active = 1) AS users,
              (SELECT COUNT(*) FROM users WHERE active = 1 AND is_admin = 1) AS administrators,
              (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS sessions`)
      .bind(nowIso).first<CountRow>(),
    env.DB.prepare(
      `SELECT s.created_at AS at, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC LIMIT 3`).all<{ at: string; email: string }>(),
    env.BTC_SIGNALS.prepare('SELECT COUNT(*) AS observations FROM bs_observations').first<{ observations: number }>(),
    env.ANALYTICS.prepare('SELECT COUNT(*) AS sites FROM analytics_sites WHERE active = 1').first<{ sites: number }>(),
    collectionView(env.BTC_SIGNALS, now),
    jobViews(env, now),
    backupState(env, now),
  ]);

  const databaseHealth = await Promise.all(CONSOLE_DATABASES.map(async database => {
    try {
      await databaseForBinding(env, database.binding).prepare('SELECT 1 AS ok').first();
      return { id: database.id, label: database.label, reachable: true };
    } catch {
      return { id: database.id, label: database.label, reachable: false };
    }
  }));
  return buildOverview({
    env, caller, now, nowIso, counts, recentSessions: recentSessions.results,
    signalsObservations: Number(signalsCount?.observations ?? 0),
    analyticsSites: Number(analyticsSites?.sites ?? 0),
    signalsCollection, jobs: jobs.jobs, backup, databaseHealth,
  });
}

interface OverviewInputs {
  env: Bindings;
  caller: { email: string; is_admin: boolean };
  now: Date;
  nowIso: string;
  counts: CountRow | null;
  recentSessions: { at: string; email: string }[];
  signalsObservations: number;
  analyticsSites: number;
  signalsCollection: CollectionView;
  jobs: JobView[];
  backup: Awaited<ReturnType<typeof backupState>>;
  databaseHealth: { id: string; label: string; reachable: boolean }[];
}

function buildOverview(input: OverviewInputs): ConsoleOverview {
  const { signalsCollection, jobs, backup } = input;
  const warnings: Warning[] = [];
  for (const database of input.databaseHealth) {
    if (!database.reachable) warnings.push({ severity: 'error', area: 'database', message: `${database.label} is not reachable` });
  }
  if (signalsCollection.failing_sources > 0) {
    warnings.push({ severity: 'warning', area: 'signals', message: `${signalsCollection.failing_sources} Bitcoin Signals source(s) last reported a failure` });
  }
  if (signalsCollection.stale_sources > 0) {
    warnings.push({ severity: 'warning', area: 'signals', message: `${signalsCollection.stale_sources} Bitcoin Signals source(s) are stale` });
  }
  for (const job of jobs) {
    for (const message of job.warnings) warnings.push({ severity: 'warning', area: 'jobs', message: `${job.name}: ${message}` });
  }
  if (!backup.recorded) {
    warnings.push({ severity: 'info', area: 'backup', message: 'No backup attestation has been recorded yet' });
  } else if (backup.ok === false) {
    warnings.push({ severity: 'error', area: 'backup', message: 'The last recorded backup verification did not pass' });
  } else if (backup.stale) {
    warnings.push({ severity: 'warning', area: 'backup', message: `The last backup attestation is older than ${backup.max_age_hours}h` });
  }

  const activity: ActivityEntry[] = [];
  for (const run of signalsCollection.last_runs.slice(0, 4)) {
    activity.push({
      at: run.started_at, area: 'Bitcoin Signals', status: run.status,
      summary: `${run.job} run: ${run.observations_added} observation(s) added, ${run.sources_ok} ok / ${run.sources_failed} failed`,
    });
  }
  for (const job of jobs) {
    if (!job.last_attempt) continue;
    activity.push({ at: job.last_attempt.started_at, area: 'Jobs', status: job.last_attempt.status, summary: job.name });
  }
  for (const session of input.recentSessions) {
    activity.push({ at: session.at, area: 'Identity', status: 'session', summary: `Sign-in by ${session.email}` });
  }
  activity.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    generated_at: input.nowIso,
    caller: input.caller,
    revision: deploymentIdentity('cflab', input.env).revision,
    summary: {
      projects: Number(input.counts?.projects ?? 0),
      active_projects: Number(input.counts?.active_projects ?? 0),
      users: Number(input.counts?.users ?? 0),
      administrators: Number(input.counts?.administrators ?? 0),
      sessions: Number(input.counts?.sessions ?? 0),
      analytics_sites: input.analyticsSites,
      signals_observations: input.signalsObservations,
      databases: CONSOLE_DATABASES.length,
      jobs: jobs.length,
    },
    health: { databases: input.databaseHealth },
    warnings,
    activity: activity.slice(0, 12),
  };
}

export interface ConsoleBinding {
  name: string;
  type: string;
  configured: boolean;
  purpose: string;
}

export interface ConsoleSystem {
  generated_at: string;
  worker: string;
  revision: string;
  bindings: ConsoleBinding[];
  databases: DatabaseInventory[];
  backup: Awaited<ReturnType<typeof backupState>>;
  notes: string[];
}

// Presence-only binding inventory. A value is never read into the response, and
// a secret is reported as configured or absent, never echoed.
export async function systemView(env: Bindings, now = new Date()): Promise<ConsoleSystem> {
  const [databases, backup] = await Promise.all([databaseInventory(env), backupState(env, now)]);
  const secretPresent = (value: unknown) => typeof value === 'string' && value.length > 0;
  return {
    generated_at: now.toISOString(),
    worker: 'cflab',
    revision: deploymentIdentity('cflab', env).revision,
    bindings: [
      { name: 'DB', type: 'D1', configured: !!env.DB, purpose: 'Primary project database' },
      { name: 'ANALYTICS', type: 'D1', configured: !!env.ANALYTICS, purpose: 'Analytics sites and events' },
      { name: 'BTC_SIGNALS', type: 'D1', configured: !!env.BTC_SIGNALS, purpose: 'Bitcoin Signals research data' },
      { name: 'FILES', type: 'R2', configured: !!env.FILES, purpose: 'Project file objects' },
      { name: 'EMAIL', type: 'Email Sending', configured: !!env.EMAIL, purpose: 'Invitations and optional Signals alerts' },
      { name: 'RL_LOGIN', type: 'Rate limit', configured: !!env.RL_LOGIN, purpose: 'Login attempts' },
      { name: 'RL_ANALYTICS', type: 'Rate limit', configured: !!env.RL_ANALYTICS, purpose: 'Collector requests' },
      { name: 'DEPLOY_REVISION', type: 'Variable', configured: secretPresent(env.DEPLOY_REVISION), purpose: 'Release identity' },
      { name: 'PROXY_SECRETS', type: 'Secret', configured: secretPresent(env.PROXY_SECRETS), purpose: 'Optional proxy header secrets' },
      { name: 'COINGECKO_DEMO_API_KEY', type: 'Secret', configured: secretPresent(env.COINGECKO_DEMO_API_KEY), purpose: 'CoinGecko treasury authentication' },
    ],
    databases,
    backup,
    notes: [
      'Binding values are never returned; only presence is reported.',
      'The isolated backup bucket is not bound to this Worker, so backup freshness comes from the recorded attestation.',
    ],
  };
}

