// Search Console administration routes.
//
// The service account stays server-side. `/properties` is the original
// connectivity probe: it proves the secret is installed and that the account can
// see its properties. `/status` reads only what collection has already stored, so
// an administrator can see mapping, coverage and freshness without spending a
// Google API request. `/sync` is the only write-shaped endpoint and it is
// administrator-only, lease-guarded and limited to MAX_MANUAL_RUNS_PER_HOUR.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { ApiError } from '../http';
import { authenticate } from './auth';
import type { AnalyticsEnv } from './env';
import { discoverSearchConsoleProperties, errorCode } from './gsc-client';
import { GSC_PROPERTIES, parseProperty } from './gsc-properties';
import {
  consumeManualRun, readSyncState, runGscCollection, siteIdBySlug,
  MAX_MANUAL_RUNS_PER_HOUR, type GscScope,
} from './gsc-collector';

export { googleServiceToken, discoverSearchConsoleProperties } from './gsc-client';

export const gsc = new Hono<AnalyticsEnv>();

async function requireAdmin(c: Context<AnalyticsEnv>) {
  const identity = await authenticate(c.env, c.req.header('Authorization'));
  if (!identity.isAdmin) throw new ApiError(403, 'forbidden', 'Administrator access required');
  return identity;
}

gsc.get('/properties', async c => {
  await requireAdmin(c);
  const json = c.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!json) return c.json({ status: 'not_configured' }, 503);
  try {
    const properties = await discoverSearchConsoleProperties(json);
    return c.json({ status: 'ok', count: properties.length, properties });
  } catch (error) {
    const code = errorCode(error);
    // Never log Google responses, OAuth assertions, tokens or the service-account JSON.
    console.error(JSON.stringify({ event: 'gsc_discovery_failed', code }));
    return c.json({ status: 'error', code: 'gsc_connection_failed' }, 502);
  }
});

interface RegisteredPropertyRow {
  property: string;
  site_id: number | null;
  permission_level: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  days_covered: number;
  newest_day: string | null;
  first_incomplete_day: string | null;
  backfill_cursor: string | null;
  backfill_complete: number;
}

// Instance-wide diagnostics: all six reviewed properties, whether each maps to
// an existing Site, and what collection last managed to store. Read-only.
gsc.get('/status', async c => {
  await requireAdmin(c);
  const db = c.env.ANALYTICS;
  const [sync, slugs, rows] = await Promise.all([
    readSyncState(db),
    siteIdBySlug(db),
    db.prepare(
      `SELECT property, site_id, permission_level, last_attempt_at, last_success_at, last_error_code,
              days_covered, newest_day, first_incomplete_day, backfill_cursor, backfill_complete
       FROM gsc_properties`).all<RegisteredPropertyRow>(),
  ]);
  const registered = new Map(rows.results.map(row => [row.property, row]));
  const properties = GSC_PROPERTIES.map(definition => {
    const parsed = parseProperty(definition.property);
    const row = registered.get(definition.property);
    const siteId = definition.siteSlug ? slugs.get(definition.siteSlug) ?? null : null;
    return {
      property: definition.property,
      label: definition.label,
      hostname: parsed?.hostname ?? '',
      kind: parsed?.kind ?? 'domain',
      site_slug: definition.siteSlug,
      site_id: siteId,
      mapped: siteId !== null,
      permission_level: row?.permission_level ?? null,
      last_attempt_at: row?.last_attempt_at ?? null,
      last_success_at: row?.last_success_at ?? null,
      last_error_code: row?.last_error_code ?? null,
      days_covered: Number(row?.days_covered ?? 0),
      newest_day: row?.newest_day ?? null,
      first_incomplete_day: row?.first_incomplete_day ?? null,
      backfill_cursor: row?.backfill_cursor ?? null,
      backfill_complete: row ? !!row.backfill_complete : false,
    };
  });
  return c.json({
    configured: Boolean(c.env.GSC_SERVICE_ACCOUNT_JSON),
    properties,
    mapping: {
      properties: properties.length,
      mapped: properties.filter(item => item.mapped).length,
      unmapped: properties.filter(item => !item.mapped).map(item => item.property),
    },
    sync: {
      last_attempt_at: sync?.last_run_started_at ?? null,
      last_finished_at: sync?.last_run_finished_at ?? null,
      last_success_at: sync?.last_success_at ?? null,
      last_error_code: sync?.last_error_code ?? null,
      manual_runs_per_hour: MAX_MANUAL_RUNS_PER_HOUR,
    },
  });
});

const SCOPES: readonly GscScope[] = ['daily', 'backfill', 'full'];

// Administrator-only, bounded manual synchronization. It is deliberately not a
// general-purpose parameter surface: the scope is one of three fixed values and
// one run can only reach MAX_REQUESTS_PER_RUN Google requests.
gsc.post('/sync', async c => {
  const identity = await requireAdmin(c);
  if (!c.env.GSC_SERVICE_ACCOUNT_JSON) return c.json({ status: 'not_configured' }, 503);

  let scope: GscScope = 'full';
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(400, 'invalid_input', 'Malformed JSON');
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const requested = (body as { scope?: unknown }).scope;
      if (requested !== undefined) {
        if (typeof requested !== 'string' || !SCOPES.includes(requested as GscScope)) {
          throw new ApiError(400, 'invalid_input', 'Invalid scope');
        }
        scope = requested as GscScope;
      }
    }
  }

  if (!(await consumeManualRun(c.env.ANALYTICS, Date.now()))) {
    throw new ApiError(429, 'sync_rate_limited', 'Manual Search Console synchronization limit reached');
  }

  const result = await runGscCollection(c.env, { scope, trigger: 'manual', userId: identity.userId });
  if (result.reason === 'lease_held') {
    throw new ApiError(409, 'sync_in_progress', 'A Search Console synchronization is already running');
  }
  if (result.reason === 'not_configured') return c.json({ status: 'not_configured' }, 503);
  return c.json({
    status: result.status,
    scope: result.scope,
    requests: result.requests,
    days_collected: result.days_collected,
    duration_ms: result.duration_ms,
    properties: result.properties.map(outcome => ({
      property: outcome.property,
      site_slug: outcome.site_slug,
      status: outcome.status,
      windows: outcome.windows,
      days: outcome.days,
      totals_rows: outcome.totals_rows,
      query_rows: outcome.query_rows,
      page_rows: outcome.page_rows,
      breakdown_rows: outcome.breakdown_rows,
      queries_truncated: outcome.queries_truncated,
      pages_truncated: outcome.pages_truncated,
      requests: outcome.requests,
      backfill_complete: outcome.backfill_complete,
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    })),
  });
});
