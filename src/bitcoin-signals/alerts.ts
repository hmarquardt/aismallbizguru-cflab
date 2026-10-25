// Deterministic, configurable alerts.
//
// A rule is evaluated from stored observations only; there is no model, no score,
// and no automated action. Alerts are deduplicated by (rule, dedupe key) so a
// recurring condition produces one alert per day per subject, and email delivery
// is off until an administrator explicitly enables it.

import type { Bindings } from '../types';
import { ApiError } from '../http';
import { normalizeEmail } from '../auth/human';
import { sendTransactionalEmail } from '../auth/email';
import { isStale } from './market';
import { REPORTABLE_OBSERVATIONS_SQL, isSourceEnabled } from './policy';

export type AlertRuleId = 'funding-sustained' | 'treasury-change' | 'verified-development' | 'stale-source';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRules {
  funding_threshold_bps_8h: number;
  funding_sustained_periods: number;
  funding_window_hours: number;
  treasury_change_pct: number;
  treasury_change_btc: number;
  stale_multiplier: number;
  error_streak: number;
}

export interface NotificationSettings { enabled: boolean; email_to: string }

export const DEFAULT_ALERT_RULES: AlertRules = {
  funding_threshold_bps_8h: 5,
  funding_sustained_periods: 6,
  funding_window_hours: 48,
  treasury_change_pct: 2,
  treasury_change_btc: 1000,
  stale_multiplier: 3,
  error_streak: 3,
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = { enabled: false, email_to: '' };

const RULE_LIMITS: Record<keyof AlertRules, [number, number, boolean]> = {
  funding_threshold_bps_8h: [0, 1000, false],
  funding_sustained_periods: [1, 168, true],
  funding_window_hours: [8, 720, true],
  treasury_change_pct: [0.1, 100, false],
  treasury_change_btc: [1, 1_000_000, false],
  stale_multiplier: [1, 24, false],
  error_streak: [1, 50, true],
};

export function validateAlertRules(input: Record<string, unknown>): AlertRules {
  const unknown = Object.keys(input).filter(key => !(key in DEFAULT_ALERT_RULES));
  if (unknown.length) throw new ApiError(400, 'invalid_input', `Unknown alert setting: ${unknown.join(', ')}`);
  const merged = { ...DEFAULT_ALERT_RULES, ...input } as Record<string, unknown>;
  const out = { ...DEFAULT_ALERT_RULES };
  for (const key of Object.keys(DEFAULT_ALERT_RULES) as (keyof AlertRules)[]) {
    const [min, max, integer] = RULE_LIMITS[key];
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new ApiError(400, 'invalid_input', `${key} is out of range`);
    }
    out[key] = value;
  }
  return out;
}

export function validateNotifications(input: Record<string, unknown>): NotificationSettings {
  const unknown = Object.keys(input).filter(key => !['enabled', 'email_to'].includes(key));
  if (unknown.length) throw new ApiError(400, 'invalid_input', `Unknown notification setting: ${unknown.join(', ')}`);
  if (typeof input.enabled !== 'boolean') throw new ApiError(400, 'invalid_input', 'enabled must be a boolean');
  const raw = input.email_to ?? '';
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_input', 'email_to must be a string');
  const email = raw.trim() === '' ? '' : normalizeEmail(raw);
  if (input.enabled && !email) throw new ApiError(400, 'invalid_input', 'A recipient is required before notifications are enabled');
  return { enabled: input.enabled, email_to: email };
}

export interface SignalsSettings { notifications: NotificationSettings; rules: AlertRules; assumptions: Record<string, unknown> }

async function settingValue(db: D1Database, key: string, fallback: unknown): Promise<Record<string, unknown>> {
  const row = await db.prepare('SELECT value_json FROM bs_settings WHERE key = ?').bind(key).first<{ value_json: string }>();
  if (!row) return fallback as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback as Record<string, unknown>;
  } catch {
    return fallback as Record<string, unknown>;
  }
}

export async function readSettings(db: D1Database): Promise<SignalsSettings> {
  const notifications = await settingValue(db, 'alerts.notifications', DEFAULT_NOTIFICATIONS);
  const rules = await settingValue(db, 'alerts.rules', DEFAULT_ALERT_RULES);
  const assumptions = await settingValue(db, 'arbitrage.assumptions', {});
  const safeRules = { ...DEFAULT_ALERT_RULES };
  for (const key of Object.keys(DEFAULT_ALERT_RULES) as (keyof AlertRules)[]) {
    const value = rules[key];
    const [min, max, integer] = RULE_LIMITS[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) safeRules[key] = value;
  }
  const enabled = notifications.enabled === true;
  const emailTo = typeof notifications.email_to === 'string' ? notifications.email_to : '';
  return { notifications: { enabled: enabled && emailTo !== '', email_to: emailTo }, rules: safeRules, assumptions };
}

export async function writeSetting(db: D1Database, key: string, value: unknown, userId: string, now = new Date()): Promise<void> {
  await db.prepare(
    `INSERT INTO bs_settings (key, value_json, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`)
    .bind(key, JSON.stringify(value), now.toISOString(), userId).run();
}

function utcDate(now: Date): string { return now.toISOString().slice(0, 10); }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

interface NewAlert {
  ruleId: AlertRuleId;
  dedupeKey: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  observedValue?: number | null;
  threshold?: number | null;
}

interface StoredAlert { id: string; rule_id: string; severity: AlertSeverity; title: string; detail: string }

// One alert per (rule, dedupe key). A duplicate is not re-delivered, which is what
// keeps a persistent condition from becoming an email loop.
async function recordAlert(db: D1Database, alert: NewAlert, now: Date): Promise<StoredAlert | null> {
  const id = crypto.randomUUID();
  const result = await db.prepare(
    `INSERT INTO bs_alerts (id, rule_id, dedupe_key, severity, title, detail, observed_value, threshold, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (rule_id, dedupe_key) DO NOTHING`)
    .bind(id, alert.ruleId, alert.dedupeKey, alert.severity, alert.title.slice(0, 200), alert.detail.slice(0, 2000), alert.observedValue ?? null, alert.threshold ?? null, now.toISOString())
    .run();
  if (Number(result.meta.changes ?? 0) === 0) return null;
  return { id, rule_id: alert.ruleId, severity: alert.severity, title: alert.title, detail: alert.detail };
}

async function deliver(env: Bindings, alert: StoredAlert, notifications: NotificationSettings, now: Date): Promise<void> {
  // In-app alerts exist regardless; email is opt-in.
  if (!notifications.enabled || !notifications.email_to) return;
  const attemptedAt = now.toISOString();
  const base = (env.AUTH_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const link = base ? `${base}/bitcoin-signals` : '/bitcoin-signals';
  try {
    await sendTransactionalEmail(env, {
      to: notifications.email_to,
      subject: `[Bitcoin Signals] ${alert.severity}: ${alert.title}`,
      text: `${alert.detail}\n\nOpen the dashboard: ${link}\n\nThis is a deterministic threshold notice, not trading advice.`,
      html: `<p>${escapeHtml(alert.detail)}</p><p><a href="${escapeHtml(link)}">Open Bitcoin Signals</a></p>`
        + '<p style="color:#5f6b7a;font-size:13px">This is a deterministic threshold notice, not trading advice.</p>',
    });
    await recordDelivery(env, alert.id, notifications.email_to, 'sent', attemptedAt, null);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'delivery_failed';
    await recordDelivery(env, alert.id, notifications.email_to, 'failed', attemptedAt, code);
  }
}

async function recordDelivery(env: Bindings, alertId: string, recipient: string, status: 'sent' | 'failed', attemptedAt: string, errorCode: string | null): Promise<void> {
  await env.BTC_SIGNALS.prepare('INSERT INTO bs_alert_deliveries (id, alert_id, channel, recipient, status, attempted_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), alertId, 'email', recipient, status, attemptedAt, errorCode).run();
}

const LATEST_REVISION = `revision = (SELECT MAX(revision) FROM bs_observations x
  WHERE x.source_id = bs_observations.source_id AND x.series = bs_observations.series
    AND x.venue = bs_observations.venue AND x.observed_at = bs_observations.observed_at)`;

export interface AlertEvaluation { created: number; rules: AlertRuleId[] }

// Evaluates every rule against stored data. Runs after each collection and from
// the daily job; a failure here must never lose observations, so the caller logs
// and continues.
export async function evaluateAlerts(env: Bindings, { now = new Date() }: { job?: string; now?: Date } = {}): Promise<AlertEvaluation> {
  const db = env.BTC_SIGNALS;
  const settings = await readSettings(db);
  const rules = settings.rules;
  const created: StoredAlert[] = [];

  // 1. Sustained funding: the mean of retained samples inside the window must
  //    clear the threshold and the window must contain enough samples.
  const windowStart = new Date(now.getTime() - rules.funding_window_hours * 3_600_000).toISOString();
  const funding = await db.prepare(
    `SELECT venue, AVG(value) AS mean, COUNT(*) AS n, MAX(observed_at) AS last_at
     FROM bs_observations
     WHERE series = 'funding_current_8h' AND ${REPORTABLE_OBSERVATIONS_SQL} AND observed_at >= ? AND observed_at <= ? AND ${LATEST_REVISION}
     GROUP BY venue ORDER BY venue`)
    .bind(windowStart, now.toISOString()).all<{ venue: string; mean: number; n: number; last_at: string }>();
  for (const row of funding.results) {
    const n = Number(row.n);
    const meanBps = Number(row.mean) * 10_000;
    if (isStale(row.last_at, now.toISOString()) || n < rules.funding_sustained_periods || meanBps < rules.funding_threshold_bps_8h) continue;
    const alert = await recordAlert(db, {
      ruleId: 'funding-sustained', dedupeKey: `${row.venue}:${utcDate(now)}`, severity: 'warning',
      title: `Sustained funding on ${row.venue}`,
      detail: `Mean funding over ${n} samples in the last ${rules.funding_window_hours}h is ${meanBps.toFixed(2)} bps per 8h (threshold ${rules.funding_threshold_bps_8h} bps). Last observation ${row.last_at}. Indicative only: fees, slippage, and liquidity are not deducted here.`,
      observedValue: meanBps, threshold: rules.funding_threshold_bps_8h,
    }, now);
    if (alert) created.push(alert);
  }

  // 2. Material treasury change between the two most recent daily totals.
  const treasury = await db.prepare(
    `SELECT observed_at, value FROM (
       SELECT observed_at, value, ROW_NUMBER() OVER (PARTITION BY substr(observed_at, 1, 10) ORDER BY observed_at DESC) AS daily_rank
       FROM bs_observations WHERE series = 'treasury_total_btc' AND ${REPORTABLE_OBSERVATIONS_SQL} AND observed_at <= ? AND ${LATEST_REVISION}
     ) WHERE daily_rank = 1 ORDER BY observed_at DESC LIMIT 2`).bind(now.toISOString()).all<{ observed_at: string; value: number }>();
  const latest = treasury.results[0];
  const previous = treasury.results[1];
  if (latest && previous && !isStale(latest.observed_at, now.toISOString(), 48)) {
    const delta = Number(latest.value) - Number(previous.value);
    const pct = Number(previous.value) === 0 ? 0 : (delta / Number(previous.value)) * 100;
    if (Math.abs(pct) >= rules.treasury_change_pct || Math.abs(delta) >= rules.treasury_change_btc) {
      const alert = await recordAlert(db, {
        ruleId: 'treasury-change', dedupeKey: latest.observed_at.slice(0, 10), severity: Math.abs(pct) >= rules.treasury_change_pct * 2 ? 'warning' : 'info',
        title: 'Reported public-company treasury changed',
        detail: `Reported holdings moved from ${Number(previous.value).toFixed(2)} BTC to ${Number(latest.value).toFixed(2)} BTC (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} BTC, ${pct.toFixed(2)}%). Source: CoinGecko aggregation of public disclosures, not an audit.`,
        observedValue: delta, threshold: rules.treasury_change_btc,
      }, now);
      if (alert) created.push(alert);
    }
  }

  // 3. Stale or failing sources: no successful run inside the multiplier window,
  //    or a consecutive failure streak for the most recent runs.
  const sources = await db.prepare('SELECT id, cadence FROM bs_sources WHERE active = 1 AND cadence IN (\'hourly\', \'daily\') ORDER BY id')
    .all<{ id: string; cadence: 'hourly' | 'daily' }>();
  for (const source of sources.results) {
    if (!isSourceEnabled(source.id)) continue;
    const recent = await db.prepare('SELECT status, started_at FROM bs_source_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 50')
      .bind(source.id).all<{ status: string; started_at: string }>();
    const runsFor = recent.results;
    // A fresh installation has no history to judge: only a source that has
    // actually been attempted can be stale or failing.
    if (runsFor.length === 0) continue;
    const lastOk = runsFor.find(run => run.status === 'ok');
    let streak = 0;
    for (const run of runsFor) { if (run.status === 'failed') streak += 1; else break; }
    const expectedHours = source.cadence === 'hourly' ? 1 : 24;
    const maxAgeHours = expectedHours * rules.stale_multiplier;
    const stale = !lastOk || (now.getTime() - Date.parse(lastOk.started_at)) > maxAgeHours * 3_600_000;
    if (!stale && streak < rules.error_streak) continue;
    const alert = await recordAlert(db, {
      ruleId: 'stale-source', dedupeKey: `${source.id}:${utcDate(now)}`, severity: streak >= rules.error_streak ? 'warning' : 'info',
      title: `Data source needs attention: ${source.id}`,
      detail: stale
        ? `No successful collection for ${source.id} within ${maxAgeHours}h (${source.cadence} cadence). Consecutive failures: ${streak}. Retained history is unchanged.`
        : `${source.id} failed ${streak} consecutive collections. Retained history is unchanged.`,
      observedValue: streak, threshold: rules.error_streak,
    }, now);
    if (alert) created.push(alert);
  }

  for (const alert of created) await deliver(env, alert, settings.notifications, now);
  return { created: created.length, rules: [...new Set(created.map(alert => alert.rule_id))] as AlertRuleId[] };
}

// Called when an administrator verifies an important evidence entry. The evidence
// timeline is human-curated, so this is the only path that can raise a
// development alert, and only after a human review.
export async function alertVerifiedDevelopment(env: Bindings, evidence: { id: string; title: string; importance: string; kind: string }): Promise<boolean> {
  if (evidence.importance !== 'high') return false;
  const now = new Date();
  const db = env.BTC_SIGNALS;
  const alert = await recordAlert(db, {
    ruleId: 'verified-development', dedupeKey: evidence.id, severity: 'info',
    title: `Verified development: ${evidence.title}`,
    detail: `A human reviewer verified an important ${evidence.kind} evidence entry. Open the Evidence section for the cited source.`,
    observedValue: null, threshold: null,
  }, now);
  if (!alert) return false;
  const settings = await readSettings(db);
  await deliver(env, alert, settings.notifications, now);
  return true;
}
