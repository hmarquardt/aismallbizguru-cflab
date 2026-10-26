// Bitcoin Signals HTTP API.
//
// Authorization reuses CFLab identity: a human session is
// validated against the primary database, then pinned to the existing operator's
// immutable user ID. Global-admin status or membership alone grants no access.
// All research data uses BTC_SIGNALS. The owner retains the existing
// administrator operations (settings, refresh, backup attestation and export).

import { Hono } from 'hono';
import type { ContextEnv, HumanUser } from '../types';
import { ApiError, fields, invalid, jsonBody, string } from '../http';
import { HUMAN_TOKEN_PATTERN, sessionUser } from '../auth/human';
import { hashToken } from '../auth/crypto';
import { BITCOIN_SIGNALS } from '../projects';
import { DEFAULT_ASSUMPTIONS, validateAssumptions, type CarryAssumptions } from './market';
import { runCollectionJob, type CollectionResult } from './collector';
import { alertVerifiedDevelopment, readSettings, validateAlertRules, validateNotifications } from './alerts';
import {
  EVIDENCE_FILTERS, arbitrageView, evidenceList, exportEvidenceCsv, exportObservationsCsv, radarView,
} from './queries';
import { projectStatus } from './status';
import { requireSignalsOwner } from './access';
import { SERIES } from './sources';
import { SOURCE_POLICY, isSourceEnabled } from './policy';

export const signals = new Hono<ContextEnv>();

// Human sessions only: machine app tokens are capabilities for the record/file
// API and are not a project-membership credential here.
signals.use('*', async (c, next) => {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
  if (!token || !HUMAN_TOKEN_PATTERN.test(token)) throw new ApiError(401, 'unauthorized', 'A human session is required');
  const user = await sessionUser(c.env, token);
  requireSignalsOwner(user);
  const project = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ? AND active = 1').bind(BITCOIN_SIGNALS.appId).first();
  if (!project) throw new ApiError(404, 'app_not_found', 'App not found');
  c.set('user', user);
  c.set('projectAccess', 'write');
  await next();
});

function currentUser(c: { get: (key: 'user') => HumanUser | undefined }): HumanUser {
  const user = c.get('user');
  if (!user) throw new ApiError(401, 'unauthorized', 'A human session is required');
  return user;
}

function requireWrite(c: { get: (key: 'projectAccess') => 'read' | 'write' | undefined }): void {
  if (c.get('projectAccess') !== 'write') throw new ApiError(403, 'insufficient_access', 'Write access to Bitcoin Signals is required');
}

function requireAdmin(c: { get: (key: 'user') => HumanUser | undefined }): HumanUser {
  const user = currentUser(c);
  if (!user.is_admin) throw new ApiError(403, 'forbidden', 'Administrator access required');
  return user;
}

function isoDate(value: unknown, name: string): string {
  const raw = string(value, name, 40);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) invalid(`Invalid ${name}`);
  return new Date(ms).toISOString();
}

function sourceUrl(value: unknown): string {
  const raw = string(value, 'source_url', 2000);
  let url: URL;
  try { url = new URL(raw); } catch { invalid('Invalid source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid('source_url must be HTTPS without credentials');
  return url.toString();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(`Invalid ${name}`);
  return value as T;
}

const EVIDENCE_KINDS = EVIDENCE_FILTERS.kinds;
const EVIDENCE_STATUSES = EVIDENCE_FILTERS.statuses;
const DIRECTIONS = ['supports', 'contradicts', 'mixed'] as const;
const IMPORTANCE = ['low', 'normal', 'high'] as const;
const REVIEW = ['unreviewed', 'verified', 'rejected'] as const;

interface HypothesisLink { id: string; effect: 'supports' | 'contradicts' | 'mixed' }

async function hypothesisLinks(db: D1Database, value: unknown): Promise<HypothesisLink[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6) invalid('Invalid hypotheses');
  const known = await db.prepare('SELECT id FROM bs_hypotheses').all<{ id: string }>();
  const ids = new Set(known.results.map(row => row.id));
  const seen = new Set<string>();
  const links: HypothesisLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('Invalid hypotheses');
    const record = entry as Record<string, unknown>;
    fields(record, ['id', 'effect']);
    const id = string(record.id, 'hypothesis id', 64);
    if (!ids.has(id)) invalid('Unknown hypothesis');
    if (seen.has(id)) invalid('Duplicate hypothesis');
    seen.add(id);
    links.push({ id, effect: oneOf(record.effect, DIRECTIONS, 'effect') });
  }
  return links;
}

signals.get('/radar', async c => {
  const user = currentUser(c);
  return c.json({
    ...await radarView(c.env.BTC_SIGNALS),
    caller: { email: user.email, is_admin: user.is_admin, access: c.get('projectAccess') ?? 'read' },
  });
});

signals.get('/arbitrage', async c => {
  const url = new URL(c.req.url);
  const allowed = new Set(['fee_bps', 'slippage_bps', 'legs', 'holding_days']);
  const overrides: Record<string, number> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) invalid('Unknown or repeated query parameter');
  }
  const numeric = (name: string, target: keyof CarryAssumptions) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return;
    if (!/^\d{1,4}$/.test(raw)) invalid(`Invalid ${name}`);
    overrides[target] = Number(raw);
  };
  numeric('fee_bps', 'feeBpsPerLeg');
  numeric('slippage_bps', 'slippageBpsPerLeg');
  numeric('legs', 'legs');
  numeric('holding_days', 'holdingDays');
  // Reject an out-of-range override here, so a bad request is a 400 and a database
  // failure stays a 500.
  if (Object.keys(overrides).length) {
    try {
      validateAssumptions(overrides);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid assumptions');
    }
  }
  return c.json(await arbitrageView(c.env.BTC_SIGNALS, { overrides }));
});

signals.get('/evidence', async c => {
  const url = new URL(c.req.url);
  const allowed = new Set(['q', 'kind', 'status', 'review', 'limit', 'offset']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) invalid('Unknown or repeated query parameter');
  }
  const limitRaw = url.searchParams.get('limit') ?? '50';
  const offsetRaw = url.searchParams.get('offset') ?? '0';
  if (!/^\d{1,3}$/.test(limitRaw) || !/^\d{1,5}$/.test(offsetRaw)) invalid('Invalid pagination');
  const query = (url.searchParams.get('q') ?? '').slice(0, 100);
  const view = await evidenceList(c.env.BTC_SIGNALS, {
    q: query, limit: Number(limitRaw), offset: Number(offsetRaw),
    ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind')! } : {}),
    ...(url.searchParams.get('status') ? { status: url.searchParams.get('status')! } : {}),
    ...(url.searchParams.get('review') ? { review: url.searchParams.get('review')! } : {}),
  });
  return c.json({ ...view, filters: EVIDENCE_FILTERS });
});

// Curated research: a member with write access records an attributed public source.
// Nothing here is machine-measured, and the fingerprint makes a repeat creation a
// conflict rather than a duplicate timeline entry.
signals.post('/evidence', async c => {
  requireWrite(c);
  const body = await jsonBody(c.req.raw);
  fields(body, ['kind', 'title', 'summary', 'occurred_at', 'jurisdiction', 'status', 'direction', 'importance', 'source_title', 'source_url', 'published_at', 'hypotheses']);
  const kind = oneOf(body.kind, EVIDENCE_KINDS, 'kind');
  const title = string(body.title, 'title', 200);
  const summary = string(body.summary, 'summary', 4000);
  const occurredAt = isoDate(body.occurred_at, 'occurred_at');
  const status = oneOf(body.status ?? 'effective', EVIDENCE_STATUSES, 'status');
  const direction = oneOf(body.direction, DIRECTIONS, 'direction');
  const importance = oneOf(body.importance ?? 'normal', IMPORTANCE, 'importance');
  const sourceTitle = string(body.source_title, 'source_title', 200);
  const url = sourceUrl(body.source_url);
  const publishedAt = body.published_at === undefined || body.published_at === null ? null : isoDate(body.published_at, 'published_at');
  const jurisdiction = body.jurisdiction === undefined || body.jurisdiction === null ? null : string(body.jurisdiction, 'jurisdiction', 60);
  if (Date.parse(occurredAt) > Date.now() + 86_400_000) invalid('occurred_at cannot be in the future');
  const links = await hypothesisLinks(c.env.BTC_SIGNALS, body.hypotheses);
  const fingerprint = await hashToken([kind, title.toLowerCase(), occurredAt, url].join('|'));
  const existing = await c.env.BTC_SIGNALS.prepare('SELECT id FROM bs_evidence WHERE fingerprint = ?').bind(fingerprint).first<{ id: string }>();
  if (existing) throw new ApiError(409, 'evidence_exists', 'This evidence entry already exists');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [c.env.BTC_SIGNALS.prepare(
    `INSERT INTO bs_evidence (id, kind, title, summary, occurred_at, jurisdiction, status, direction, importance, source_title, source_url, published_at, retrieved_at, review_status, created_at, updated_at, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?, ?)`)
    .bind(id, kind, title, summary, occurredAt, jurisdiction, status, direction, importance, sourceTitle, url, publishedAt, now, now, now, fingerprint),
    ...links.map(link => c.env.BTC_SIGNALS.prepare('INSERT INTO bs_evidence_hypotheses (evidence_id, hypothesis_id, effect) VALUES (?, ?, ?)').bind(id, link.id, link.effect)),
  ];
  await c.env.BTC_SIGNALS.batch(statements);
  return c.json({
    evidence: { id, kind, title, summary, occurred_at: occurredAt, jurisdiction, status, direction, importance, source_title: sourceTitle, source_url: url, published_at: publishedAt, retrieved_at: now, review_status: 'unreviewed', hypotheses: links },
  }, 201);
});

// Review is the only mutation of an existing entry: a correction appends context,
// and a rejected entry stays in the timeline with its provenance.
signals.patch('/evidence/:id', async c => {
  requireWrite(c);
  const user = currentUser(c);
  const id = string(c.req.param('id'), 'id', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) invalid('Invalid id');
  const body = await jsonBody(c.req.raw);
  fields(body, ['review_status', 'summary']);
  if (body.review_status === undefined && body.summary === undefined) invalid('At least one field is required');
  const existing = await c.env.BTC_SIGNALS.prepare('SELECT id, title, kind, importance FROM bs_evidence WHERE id = ?').bind(id)
    .first<{ id: string; title: string; kind: string; importance: string }>();
  if (!existing) throw new ApiError(404, 'evidence_not_found', 'Evidence not found');
  const now = new Date().toISOString();
  // Validate the whole patch before changing either field.
  const summary = body.summary === undefined ? undefined : string(body.summary, 'summary', 4000);
  const review = body.review_status === undefined ? undefined : oneOf(body.review_status, REVIEW, 'review_status');
  const statements: D1PreparedStatement[] = [];
  if (body.summary !== undefined) {
    statements.push(c.env.BTC_SIGNALS.prepare('UPDATE bs_evidence SET summary = ?, updated_at = ? WHERE id = ?')
      .bind(summary, now, id));
  }
  if (review !== undefined) {
    statements.push(c.env.BTC_SIGNALS.prepare('UPDATE bs_evidence SET review_status = ?, reviewed_by_user_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
      .bind(review, user.id, now, now, id));
  }
  await c.env.BTC_SIGNALS.batch(statements);
  if (review === 'verified') await alertVerifiedDevelopment(c.env, existing);
  return c.json({ updated: true, id });
});

signals.get('/settings', async c => {
  requireAdmin(c);
  const settings = await readSettings(c.env.BTC_SIGNALS);
  const sources = await c.env.BTC_SIGNALS.prepare('SELECT id, name, homepage, cadence, default_tier, definition, active FROM bs_sources ORDER BY id')
    .all<{ id: string; name: string; homepage: string; cadence: string; default_tier: string; definition: string; active: number }>();
  return c.json({
    notifications: settings.notifications,
    rules: settings.rules,
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...settings.assumptions },
    sources: sources.results.map(source => ({ ...source, active: source.active === 1 && isSourceEnabled(source.id),
      disabled_reason: isSourceEnabled(source.id) ? null : SOURCE_POLICY[source.id]?.reason ?? 'Source not approved' })),
    status: await projectStatus(c.env),
  });
});

signals.patch('/settings', async c => {
  const user = requireAdmin(c);
  const body = await jsonBody(c.req.raw);
  fields(body, ['notifications', 'rules', 'assumptions']);
  if (!Object.keys(body).length) invalid('At least one field is required');
  // A partial update is merged onto the stored value, so changing one threshold
  // cannot silently reset the others to their defaults.
  const stored = await readSettings(c.env.BTC_SIGNALS);
  const updates: { key: string; value: unknown }[] = [];
  if (body.notifications !== undefined) {
    const value = body.notifications;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid notifications');
    updates.push({ key: 'alerts.notifications', value: validateNotifications({ ...stored.notifications, ...value as Record<string, unknown> }) });
  }
  if (body.rules !== undefined) {
    const value = body.rules;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid rules');
    updates.push({ key: 'alerts.rules', value: validateAlertRules({ ...stored.rules, ...value as Record<string, unknown> }) });
  }
  if (body.assumptions !== undefined) {
    const value = body.assumptions;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid assumptions');
    let assumptions;
    try {
      assumptions = validateAssumptions({ ...DEFAULT_ASSUMPTIONS, ...stored.assumptions, ...value as Record<string, unknown> });
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid assumptions');
    }
    updates.push({ key: 'arbitrage.assumptions', value: assumptions });
  }
  await c.env.BTC_SIGNALS.batch(updates.map(update => c.env.BTC_SIGNALS.prepare(
    `INSERT INTO bs_settings (key, value_json, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`)
    .bind(update.key, JSON.stringify(update.value), new Date().toISOString(), user.id)));
  const settings = await readSettings(c.env.BTC_SIGNALS);
  return c.json({ notifications: settings.notifications, rules: settings.rules, assumptions: { ...DEFAULT_ASSUMPTIONS, ...settings.assumptions } });
});

// Administrator-only manual refresh. It runs the same collectors as the cron
// jobs, is bounded to four manual runs per hour, and cannot overlap a running
// collection (the lease is shared with the schedule).
signals.post('/refresh', async c => {
  const user = requireAdmin(c);
  const body = await jsonBody(c.req.raw);
  fields(body, ['scope']);
  const scope = oneOf(body.scope ?? 'hourly', ['hourly', 'daily', 'all'] as const, 'scope');
  const jobs: ('hourly' | 'daily')[] = scope === 'all' ? ['hourly', 'daily'] : [scope];
  const runs: CollectionResult[] = [];
  for (const job of jobs) runs.push(await runCollectionJob(c.env, job, { trigger: 'manual', userId: user.id }));
  if (runs.every(run => run.status === 'skipped' && run.reason === 'manual_rate_limited')) {
    throw new ApiError(429, 'refresh_rate_limited', 'Too many manual refreshes in the last hour');
  }
  return c.json({ runs });
});

signals.get('/status', async c => {
  requireAdmin(c);
  return c.json(await projectStatus(c.env));
});

signals.post('/alerts/:id/ack', async c => {
  const user = requireAdmin(c);
  const id = string(c.req.param('id'), 'id', 36);
  const result = await c.env.BTC_SIGNALS.prepare('UPDATE bs_alerts SET acknowledged_at = ?, acknowledged_by_user_id = ? WHERE id = ? AND acknowledged_at IS NULL')
    .bind(new Date().toISOString(), user.id, id).run();
  if (!Number(result.meta.changes ?? 0)) throw new ApiError(404, 'alert_not_found', 'Alert not found or already acknowledged');
  return c.json({ acknowledged: true, id });
});

// Backup status is attested from the read-only backup report. The Worker has no
// backup-bucket credential, so the operator records what the verified tooling
// reported; the recorded verdict is recomputed here from the per-database status
// instead of trusting the uploaded `ok` flag.
const BACKUP_COVERAGE = ['cflab', 'cflab-analytics', 'cflab-bitcoin-signals'];

signals.post('/backup-attestation', async c => {
  const user = requireAdmin(c);
  const body = await jsonBody(c.req.raw);
  fields(body, ['ok', 'max_age_hours', 'report', 'problems']);
  const maxAge = Number(body.max_age_hours);
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 168) invalid('max_age_hours is out of range');
  if (!Array.isArray(body.report)) invalid('report must be an array');
  const entries = body.report.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('Invalid report entry');
    const record = entry as Record<string, unknown>;
    const database = string(record.database, 'database', 64);
    const status = oneOf(record.status, ['fresh', 'stale', 'missing'] as const, 'status');
    const capturedAt = typeof record.captured_at === 'string' ? record.captured_at : null;
    return { database, status, capturedAt };
  });
  const missing = BACKUP_COVERAGE.filter(database => !entries.some(entry => entry.database === database));
  if (missing.length) invalid(`The report must cover ${BACKUP_COVERAGE.join(', ')}; missing ${missing.join(', ')}`);
  if (entries.length !== BACKUP_COVERAGE.length || new Set(entries.map(entry => entry.database)).size !== entries.length) invalid('The report must contain exactly one entry per production database');
  const ok = BACKUP_COVERAGE.every(database => {
    const entry = entries.find(entry => entry.database === database)!;
    const captured = Date.parse(entry.capturedAt ?? '');
    const age = Date.now() - captured;
    return entry.status === 'fresh' && Number.isFinite(captured) && age >= 0 && age <= maxAge * 3_600_000;
  });
  const reportJson = JSON.stringify(body.report);
  if (reportJson.length > 20_000) invalid('report is too large');
  const checkedAt = new Date().toISOString();
  await c.env.BTC_SIGNALS.prepare(
    'INSERT INTO bs_backup_checks (id, checked_at, source, max_age_hours, ok, report_json, recorded_at, recorded_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), checkedAt, 'scripts/backup/backup-status.mjs', maxAge, ok ? 1 : 0, reportJson, checkedAt, user.id).run();
  return c.json({ recorded: true, checked_at: checkedAt, ok });
});

// Bounded CSV export of retained history and curated evidence. No arbitrary SQL and
// no table selection: the two datasets are fixed and capped.
signals.get('/export', async c => {
  requireAdmin(c);
  const url = new URL(c.req.url);
  const allowed = new Set(['dataset', 'series']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) invalid('Unknown or repeated query parameter');
  }
  const dataset = oneOf(url.searchParams.get('dataset') ?? 'evidence', ['observations', 'evidence'] as const, 'dataset');
  const seriesParam = url.searchParams.get('series');
  if (seriesParam !== null && !Object.prototype.hasOwnProperty.call(SERIES, seriesParam)) invalid('Unknown series');
  const filename = dataset === 'observations' ? 'bitcoin-signals-observations.csv' : 'bitcoin-signals-evidence.csv';
  const csv = dataset === 'observations'
    ? await exportObservationsCsv(c.env.BTC_SIGNALS, seriesParam ? { series: seriesParam } : {})
    : await exportEvidenceCsv(c.env.BTC_SIGNALS);
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
});
