// Job observability for the operations console.
//
// This module reads history that already exists. It never schedules anything: the
// cron triggers stay exactly where they are (wrangler.jsonc for both Workers), and
// `console_jobs` only holds display metadata. Next-run times are derived from the
// same expressions, in UTC, by a deliberately small parser that returns "unknown"
// for any expression it does not fully understand instead of guessing.

import type { Bindings } from '../types';

export interface JobDefinition {
  id: string;
  service_id: string;
  name: string;
  schedule: string;
  schedule_timezone: string;
  description: string;
  history_source: 'signals-collection' | 'analytics-maintenance' | 'external-workflow';
  history_key: string | null;
  stale_after_minutes: number;
  active: boolean;
}

export interface JobRun {
  started_at: string;
  finished_at: string | null;
  status: string;
  detail: string | null;
}

export interface JobView extends JobDefinition {
  next_run_at: string | null;
  last_attempt: JobRun | null;
  last_success_at: string | null;
  last_failure: JobRun | null;
  stale: boolean;
  history: 'recorded' | 'external' | 'unavailable';
  history_error?: string;
  warnings: string[];
}

const DAY_MINUTES = 1_440;
const MAX_SCAN_DAYS = 40;

function fieldValues(field: string, min: number, max: number): number[] | null {
  if (field === '*') return [];
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) {
      const size = Number(step[1]);
      if (!Number.isInteger(size) || size < 1 || size > max) return null;
      for (let value = min; value <= max; value += size) values.add(value);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < min || value > max) return null;
    values.add(value);
  }
  return values.size ? [...values].sort((a, b) => a - b) : [];
}

export interface CronSchedule { minutes: number[] | null; hours: number[] | null }

// Comma lists, steps (`*/n`) and plain integers for the minute and hour fields;
// the date fields must be `*`. Anything else is reported as unsupported.
export function parseCron(expression: string): CronSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (day !== '*' || month !== '*' || weekday !== '*') return null;
  const minutes = fieldValues(minute, 0, 59);
  const hours = fieldValues(hour, 0, 23);
  if (minutes === null || hours === null) return null;
  return { minutes: minutes.length ? minutes : null, hours: hours.length ? hours : null };
}

export function nextCronRun(expression: string, from: Date): string | null {
  const schedule = parseCron(expression);
  if (!schedule) return null;
  const start = new Date(Math.floor((from.getTime() + 60_000) / 60_000) * 60_000);
  const limit = MAX_SCAN_DAYS * DAY_MINUTES;
  for (let step = 0; step <= limit; step += 1) {
    const candidate = new Date(start.getTime() + step * 60_000);
    if (schedule.minutes && !schedule.minutes.includes(candidate.getUTCMinutes())) continue;
    if (schedule.hours && !schedule.hours.includes(candidate.getUTCHours())) continue;
    return candidate.toISOString();
  }
  return null;
}

export function jobDefinitions(db: D1Database): Promise<JobDefinition[]> {
  return db.prepare(
    `SELECT id, service_id, name, schedule, schedule_timezone, description, history_source, history_key,
            stale_after_minutes, active FROM console_jobs WHERE active = 1 ORDER BY schedule, id`)
    .all<Omit<JobDefinition, 'active'> & { active: number }>()
    .then(result => result.results.map(row => ({ ...row, active: !!row.active })));
}

interface SignalsRunRow { started_at: string; finished_at: string | null; status: string; detail: string | null }
interface AnalyticsRunRow { started_at: string; finished_at: string | null; status: string; error_code: string | null }

async function readHistory(env: Bindings, job: JobDefinition): Promise<{ runs: JobRun[]; history: JobView['history']; error?: string }> {
  if (job.history_source === 'external-workflow') return { runs: [], history: 'external' };
  try {
    if (job.history_source === 'signals-collection') {
      const key = job.history_key ?? '';
      const { results } = await env.BTC_SIGNALS.prepare(
        `SELECT started_at, finished_at, status, detail FROM bs_collection_runs
         WHERE job = ? AND trigger = 'cron' ORDER BY started_at DESC LIMIT 10`).bind(key).all<SignalsRunRow>();
      return { runs: results.map(row => ({ ...row })), history: 'recorded' };
    }
    const { results } = await env.ANALYTICS.prepare(
      `SELECT started_at, finished_at, status, error_code FROM console_job_runs
       WHERE job = ? ORDER BY started_at DESC LIMIT 10`).bind(job.id).all<AnalyticsRunRow>();
    return {
      runs: results.map(row => ({ started_at: row.started_at, finished_at: row.finished_at, status: row.status, detail: row.error_code })),
      history: 'recorded',
    };
  } catch (error) {
    // A database without the history table yet reports honestly instead of
    // pretending the job never ran.
    return { runs: [], history: 'unavailable', error: error instanceof Error ? error.message.slice(0, 160) : 'history read failed' };
  }
}

export async function jobViews(env: Bindings, now = new Date()): Promise<{ generated_at: string; jobs: JobView[] }> {
  const definitions = await jobDefinitions(env.DB);
  const jobs = await Promise.all(definitions.map(async definition => {
    const { runs, history, error } = await readHistory(env, definition);
    const lastAttempt = runs[0] ?? null;
    const lastSuccess = runs.find(run => run.status === 'ok') ?? null;
    const lastFailure = runs.find(run => run.status !== 'ok') ?? null;
    const ageMinutes = lastSuccess ? (now.getTime() - Date.parse(lastSuccess.started_at)) / 60_000 : null;
    const stale = ageMinutes === null ? history === 'recorded' : ageMinutes > definition.stale_after_minutes;
    const warnings: string[] = [];
    if (!parseCron(definition.schedule)) warnings.push('Schedule expression is not supported by the console reader');
    if (history === 'recorded' && !lastSuccess) warnings.push('No successful run recorded');
    if (history === 'recorded' && stale && lastSuccess) warnings.push(`Last success is ${Math.round(ageMinutes! / 60)}h old`);
    if (lastAttempt && lastAttempt.status !== 'ok') warnings.push(`Last attempt ${lastAttempt.status}`);
    if (history === 'unavailable') warnings.push('History table is not available in this deployment yet');
    return {
      ...definition,
      next_run_at: nextCronRun(definition.schedule, now),
      last_attempt: lastAttempt,
      last_success_at: lastSuccess?.started_at ?? null,
      last_failure: lastFailure,
      stale,
      history,
      ...(error ? { history_error: error } : {}),
      warnings,
    };
  }));
  return { generated_at: now.toISOString(), jobs };
}
