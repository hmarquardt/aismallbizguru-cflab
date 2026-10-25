// Read models for the Bitcoin Signals dashboard.
//
// Every figure here comes from a retained observation with its own source, unit,
// timestamp, and evidence URL. Derived values (annualized funding, carry, basis,
// persistence) are computed from stored rows on read, so history is never
// rewritten and a calculation can be re-derived exactly from the data.

import { SERIES, type SeriesKey } from './sources';
import { basisAnnualized, daysBetween, estimateCarry, isStale, persistenceStats, validateAssumptions, type CarryAssumptions, type FundingSample } from './market';
import { readSettings } from './alerts';
import { REPORTABLE_OBSERVATIONS_SQL, SOURCE_POLICY, isSourceEnabled, reportableAlertsSql } from './policy';

export interface ObservationRow {
  source_id: string;
  source_url: string;
  series: string;
  venue: string;
  observed_at: string;
  retrieved_at: string;
  value: number;
  unit: string;
  definition: string;
  tier: string;
  revision: number;
  meta_json: string;
}

export interface Point { at: string; value: number }

export function seriesMeta(series: string) {
  return Object.prototype.hasOwnProperty.call(SERIES, series) ? SERIES[series as SeriesKey] : null;
}

function parseMeta(row: ObservationRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.meta_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function ageHours(observedAt: string, now: Date): number {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.round(((now.getTime() - parsed) / 3_600_000) * 100) / 100;
}

// Bound the returned venues, not the historical scan: a stopped source must keep
// appearing as stale after healthy venues add hundreds of newer observations.
export async function latestByVenue(db: D1Database, series: string, scanLimit = 400): Promise<ObservationRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY venue ORDER BY observed_at DESC, revision DESC) AS venue_rank
       FROM bs_observations WHERE series = ? AND ${REPORTABLE_OBSERVATIONS_SQL}
     ) WHERE venue_rank = 1 ORDER BY observed_at DESC LIMIT ?`)
    .bind(series, scanLimit).all<ObservationRow>();
  const seenVenues = new Set<string>();
  const seenTimestamp = new Set<string>();
  const latest: ObservationRow[] = [];
  for (const row of results) {
    const stamp = `${row.venue}|${row.observed_at}`;
    if (seenTimestamp.has(stamp)) continue;
    seenTimestamp.add(stamp);
    if (seenVenues.has(row.venue)) continue;
    seenVenues.add(row.venue);
    latest.push(row);
  }
  return latest;
}

export async function historyPoints(db: D1Database, series: string, venue: string, limit = 168): Promise<Point[]> {
  const { results } = await db.prepare(
    `SELECT observed_at, value, revision FROM bs_observations WHERE series = ? AND venue = ? AND ${REPORTABLE_OBSERVATIONS_SQL} ORDER BY observed_at DESC, revision DESC LIMIT ?`)
    .bind(series, venue, Math.min(Math.max(limit, 1), 500)).all<{ observed_at: string; value: number; revision: number }>();
  const seen = new Set<string>();
  const points: Point[] = [];
  for (const row of results) {
    if (seen.has(row.observed_at)) continue;
    seen.add(row.observed_at);
    points.push({ at: row.observed_at, value: Number(row.value) });
  }
  return points.reverse();
}

export interface CollectionSourceView {
  source_id: string;
  name: string;
  cadence: string;
  tier: string;
  last_ok_at: string | null;
  age_hours: number | null;
  last_error_code: string | null;
  last_error_at: string | null;
  healthy: boolean;
  active: boolean;
  disabled_reason: string | null;
}

export interface CollectionView {
  last_runs: { job: string; status: string; started_at: string; finished_at: string | null; observations_added: number; sources_ok: number; sources_failed: number; detail: string | null }[];
  sources: CollectionSourceView[];
  failing_sources: number;
  stale_sources: number;
}

// Collection health: the newest run per job and, per source, the last successful
// collection and its most recent error. A source with no success inside three
// collection intervals is unhealthy.
export async function collectionView(db: D1Database, now = new Date()): Promise<CollectionView> {
  const runs = await db.prepare(
    'SELECT job, status, started_at, finished_at, observations_added, sources_ok, sources_failed, detail FROM bs_collection_runs ORDER BY started_at DESC LIMIT 40')
    .all<{ job: string; status: string; started_at: string; finished_at: string | null; observations_added: number; sources_ok: number; sources_failed: number; detail: string | null }>();
  const seenJobs = new Set<string>();
  const lastRuns = runs.results.filter(run => {
    if (seenJobs.has(run.job)) return false;
    seenJobs.add(run.job);
    return true;
  });
  const sources = await db.prepare(
    `SELECT s.id, s.name, s.cadence, s.default_tier, s.active,
       (SELECT MAX(started_at) FROM bs_source_runs r WHERE r.source_id = s.id AND r.status = 'ok') AS last_ok_at,
       (SELECT error_code FROM bs_source_runs r WHERE r.source_id = s.id ORDER BY r.started_at DESC LIMIT 1) AS last_error_code,
       (SELECT started_at FROM bs_source_runs r WHERE r.source_id = s.id ORDER BY r.started_at DESC LIMIT 1) AS last_error_at,
       (SELECT status FROM bs_source_runs r WHERE r.source_id = s.id ORDER BY r.started_at DESC LIMIT 1) AS last_status
     FROM bs_sources s ORDER BY s.id`)
    .all<{ id: string; name: string; cadence: string; default_tier: string; active: number; last_ok_at: string | null; last_error_code: string | null; last_error_at: string | null; last_status: string | null }>();
  const views: CollectionSourceView[] = [];
  let failing = 0;
  let stale = 0;
  for (const source of sources.results) {
    const policy = SOURCE_POLICY[source.id];
    if (!isSourceEnabled(source.id) || source.active !== 1) {
      views.push({ source_id: source.id, name: source.name, cadence: source.cadence, tier: source.default_tier,
        active: false, disabled_reason: !isSourceEnabled(source.id) ? policy?.reason ?? 'Source not approved' : 'Source disabled in registry', healthy: false,
        last_ok_at: null, age_hours: null, last_error_code: null, last_error_at: null });
      continue;
    }
    if (source.cadence === 'curated') {
      views.push({ source_id: source.id, name: source.name, cadence: source.cadence, tier: source.default_tier, last_ok_at: null, age_hours: null, last_error_code: null, last_error_at: null, healthy: true, active: true, disabled_reason: null });
      continue;
    }
    const age = source.last_ok_at ? ageHours(source.last_ok_at, now) : null;
    const maxAgeHours = (source.cadence === 'hourly' ? 1 : 24) * 3;
    const healthy = age !== null && age <= maxAgeHours;
    if (!healthy) stale += 1;
    if (source.last_status === 'failed') failing += 1;
    views.push({
      source_id: source.id, name: source.name, cadence: source.cadence, tier: source.default_tier,
      last_ok_at: source.last_ok_at, age_hours: age,
      last_error_code: source.last_status === 'failed' ? source.last_error_code : null,
      last_error_at: source.last_status === 'failed' ? source.last_error_at : null,
      healthy,
      active: true, disabled_reason: null,
    });
  }
  return { last_runs: lastRuns, sources: views, failing_sources: failing, stale_sources: stale };
}

interface RadarSpec { series: SeriesKey; label: string; only?: string; chart?: number; maxVenues?: number }

// The radar shows indicators that speak to the monetary-adoption question. There
// is deliberately no composite score: each row is one measurement with its source.
const RADAR_SPEC: RadarSpec[] = [
  { series: 'spot_price_usd', label: 'BTC spot price', chart: 168, maxVenues: 3 },
  { series: 'funding_current_8h', label: 'Perpetual funding (per 8h)', chart: 168, maxVenues: 4 },
  { series: 'lightning_capacity_btc', label: 'Lightning capacity', chart: 60, maxVenues: 1 },
  { series: 'lightning_channel_count', label: 'Lightning channels', chart: 60, maxVenues: 1 },
  { series: 'lightning_node_count', label: 'Lightning nodes', chart: 60, maxVenues: 1 },
  { series: 'treasury_total_btc', label: 'Reported public-company holdings', chart: 60, maxVenues: 1 },
  { series: 'treasury_total_usd', label: 'Reported treasury value', chart: 60, maxVenues: 1 },
  { series: 'treasury_market_cap_dominance_pct', label: 'Reported treasury share of market cap', maxVenues: 1 },
];

export interface IndicatorView {
  series: string;
  venue: string;
  label: string;
  unit: string;
  tier: string;
  value: number;
  observed_at: string;
  retrieved_at: string;
  age_hours: number;
  stale: boolean;
  stale_after_hours: number;
  change_7d_pct: number | null;
  source_id: string;
  source_url: string;
  definition: string;
  points?: Point[];
  meta: Record<string, unknown>;
}

// Change over the last seven days, measured against the retained point closest to
// that horizon. It never compares against a much older point just because the
// series is sampled daily.
export function changeOverWeek(points: Point[] | undefined): number | null {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1]!;
  const target = Date.parse(last.at) - 7 * 86_400_000;
  let reference: Point | null = null;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const difference = Math.abs(Date.parse(point.at) - target);
    if (difference < bestDifference) { bestDifference = difference; reference = point; }
  }
  if (!reference || reference === last || reference.value === 0 || bestDifference > 24 * 3_600_000) return null;
  return ((last.value - reference.value) / Math.abs(reference.value)) * 100;
}

export interface HypothesisView {
  id: string;
  title: string;
  question: string;
  evidence: { total: number; supports: number; contradicts: number; mixed: number; verified: number; last_at: string | null };
}

export interface RadarView {
  generated_at: string;
  indicators: IndicatorView[];
  treasuries: { venue: string; btc: number; name: string; country: string | null; observed_at: string; stale: boolean }[];
  hypotheses: HypothesisView[];
  curated: { kind: string; entries: number; last_at: string | null }[];
  alerts: { id: string; severity: string; title: string; detail: string; created_at: string }[];
  collection: CollectionView;
}

export async function radarView(db: D1Database, now = new Date()): Promise<RadarView> {
  const indicators: IndicatorView[] = [];
  for (const spec of RADAR_SPEC) {
    const meta = SERIES[spec.series];
    const rows = await latestByVenue(db, spec.series);
    const selected = rows.filter(row => (spec.only ? row.venue === spec.only : true)).slice(0, spec.maxVenues ?? 6);
    for (const row of selected) {
      const points = spec.chart ? await historyPoints(db, spec.series, row.venue, spec.chart) : undefined;
      const age = ageHours(row.observed_at, now);
      indicators.push({
        series: row.series, venue: row.venue, label: meta.label, unit: row.unit, tier: row.tier,
        value: Number(row.value), observed_at: row.observed_at, retrieved_at: row.retrieved_at,
        age_hours: age, stale: age > meta.staleAfterHours || isStale(row.observed_at, row.retrieved_at, meta.staleAfterHours),
        stale_after_hours: meta.staleAfterHours, change_7d_pct: changeOverWeek(points),
        source_id: row.source_id, source_url: row.source_url, definition: row.definition,
        ...(points && points.length ? { points } : {}), meta: parseMeta(row),
      });
    }
  }

  const companies = await latestByVenue(db, 'treasury_company_btc');
  const treasuries = companies
    .map(row => {
      const meta = parseMeta(row);
      return {
        venue: row.venue, btc: Number(row.value), observed_at: row.observed_at,
        name: typeof meta.name === 'string' ? meta.name : row.venue,
        country: typeof meta.country === 'string' ? meta.country : null,
        stale: ageHours(row.observed_at, now) > SERIES.treasury_company_btc.staleAfterHours,
      };
    })
    .sort((a, b) => b.btc - a.btc)
    .slice(0, 8);

  const hypotheses = await db.prepare(
    `SELECT h.id, h.title, h.question,
       COUNT(e.id) AS total,
       COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND eh.effect = 'supports' THEN 1 ELSE 0 END), 0) AS supports,
       COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND eh.effect = 'contradicts' THEN 1 ELSE 0 END), 0) AS contradicts,
       COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND eh.effect = 'mixed' THEN 1 ELSE 0 END), 0) AS mixed,
       COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND e.review_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified,
       MAX(e.occurred_at) AS last_at
     FROM bs_hypotheses h
     LEFT JOIN bs_evidence_hypotheses eh ON eh.hypothesis_id = h.id
     LEFT JOIN bs_evidence e ON e.id = eh.evidence_id AND e.review_status <> 'rejected'
     GROUP BY h.id, h.title, h.question
     ORDER BY h.id`)
    .all<{ id: string; title: string; question: string; total: number; supports: number; contradicts: number; mixed: number; verified: number; last_at: string | null }>();

  const curated = await db.prepare(
    "SELECT kind, COUNT(*) AS entries, MAX(occurred_at) AS last_at FROM bs_evidence WHERE review_status <> 'rejected' GROUP BY kind ORDER BY kind")
    .all<{ kind: string; entries: number; last_at: string | null }>();

  const alerts = await db.prepare(
    `SELECT id, severity, title, detail, created_at FROM bs_alerts WHERE acknowledged_at IS NULL AND ${reportableAlertsSql()} ORDER BY created_at DESC LIMIT 10`)
    .all<{ id: string; severity: string; title: string; detail: string; created_at: string }>();

  return {
    generated_at: now.toISOString(),
    indicators,
    treasuries,
    hypotheses: hypotheses.results.map(row => ({
      id: row.id, title: row.title, question: row.question,
      evidence: {
        total: Number(row.total), supports: Number(row.supports), contradicts: Number(row.contradicts),
        mixed: Number(row.mixed), verified: Number(row.verified), last_at: row.last_at,
      },
    })),
    curated: curated.results.map(row => ({ kind: row.kind, entries: Number(row.entries), last_at: row.last_at })),
    alerts: alerts.results,
    collection: await collectionView(db, now),
  };
}

export interface PersistenceView {
  basis: 'settled' | 'sampled';
  samples: number;
  coverage_hours: number;
  mean_8h_pct: number | null;
  median_8h_pct: number | null;
  positive_share: number | null;
  negative_share: number | null;
  longest_positive_run: number;
  longest_negative_run: number;
  cumulative_pct: number | null;
}

export interface CarryView {
  gross_apr_pct: number;
  gross_apy_pct: number | null;
  holding_return_pct: number;
  cost_pct: number;
  cost_apr_pct: number;
  net_apr_pct: number;
  net_holding_pct: number;
  breakeven_periods: number | null;
  profitable: boolean;
}

export interface FundingVenueView {
  venue: string;
  funding_8h: number | null;
  funding_8h_pct: number | null;
  interval_hours: number | null;
  observed_at: string | null;
  age_hours: number | null;
  stale: boolean;
  mark_price_usd: number | null;
  index_price_usd: number | null;
  carry: CarryView | null;
  persistence: PersistenceView;
  limitations: string[];
}

export interface BasisView {
  venue: string;
  instrument: string;
  expiry: string;
  days_to_expiry: number;
  mark_usd: number;
  index_usd: number;
  basis_pct: number;
  annualized_pct: number;
  cost_apr_pct: number;
  net_annualized_pct: number;
  observed_at: string;
  stale: boolean;
}

export interface ArbitrageView {
  generated_at: string;
  assumptions: CarryAssumptions;
  assumption_note: string | null;
  venues: FundingVenueView[];
  basis: BasisView[];
  best_funding: { venue: string; net_apr_pct: number } | null;
  best_basis: { venue: string; instrument: string; net_annualized_pct: number } | null;
  disclaimer: string;
}

function carryView(carry: ReturnType<typeof estimateCarry>): CarryView {
  return {
    gross_apr_pct: carry.grossAprPct,
    gross_apy_pct: carry.grossApyPct,
    holding_return_pct: carry.holdingReturnPct,
    cost_pct: carry.costPct,
    cost_apr_pct: carry.costAprPct,
    net_apr_pct: carry.netAprPct,
    net_holding_pct: carry.netHoldingPct,
    breakeven_periods: carry.breakevenPeriods,
    profitable: carry.profitable,
  };
}

const VENUE_LIMITATIONS: Record<string, string[]> = {
  okx: ['Access and product availability depend on jurisdiction; some residents are restricted.', 'BTC-USDT-SWAP is a USDT-margined linear contract.'],
  deribit: ['Deribit serves non-US customers; availability depends on jurisdiction.', 'BTC-PERPETUAL is an inverse contract settled in BTC, so USD carry is approximate.', 'funding_8h is the venue-published trailing eight-hour rate; it differs from a current prediction.'],
  'kraken-futures': ['Kraken Futures availability depends on jurisdiction.', 'PF_XBTUSD is a linear multi-collateral perpetual settled in USD; its hourly relative funding rate is multiplied by eight.'],
};

async function fundingSamples(db: D1Database, series: string, sinceIso: string, now: Date): Promise<Map<string, FundingSample[]>> {
  const { results } = await db.prepare(
    `SELECT venue, observed_at, value, meta_json FROM bs_observations
     WHERE series = ? AND observed_at >= ? AND ${REPORTABLE_OBSERVATIONS_SQL} AND revision = (SELECT MAX(revision) FROM bs_observations x
       WHERE x.source_id = bs_observations.source_id AND x.series = bs_observations.series
         AND x.venue = bs_observations.venue AND x.observed_at = bs_observations.observed_at)
     ORDER BY observed_at DESC LIMIT 1200`)
    .bind(series, sinceIso).all<{ venue: string; observed_at: string; value: number; meta_json: string }>();
  const map = new Map<string, FundingSample[]>();
  for (const row of results) {
    if (Date.parse(row.observed_at) > now.getTime()) continue;
    const list = map.get(row.venue) ?? [];
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    list.push({ observedAt: row.observed_at, rate8h: Number(row.value), intervalHours: typeof meta.interval_hours === 'number' ? meta.interval_hours : 8 });
    map.set(row.venue, list);
  }
  return map;
}

function persistenceView(samples: FundingSample[], basis: 'settled' | 'sampled'): PersistenceView {
  const stats = persistenceStats(samples);
  return {
    basis, samples: stats.samples, coverage_hours: stats.coverageHours,
    mean_8h_pct: stats.mean8hPct, median_8h_pct: stats.median8hPct,
    positive_share: stats.positiveShare, negative_share: stats.negativeShare,
    longest_positive_run: stats.longestPositiveRun, longest_negative_run: stats.longestNegativeRun,
    // Sampled quotes are overlapping predictions, not settled cash flows.
    // Settled rows may have different source intervals; sum their raw payouts.
    cumulative_pct: basis === 'sampled' ? null : stats.cumulativePct,
  };
}

export async function arbitrageView(db: D1Database, options: { now?: Date; overrides?: Record<string, unknown> } = {}): Promise<ArbitrageView> {
  const now = options.now ?? new Date();
  const settings = await readSettings(db);
  let assumptions: CarryAssumptions;
  let assumptionNote: string | null = null;
  try {
    assumptions = validateAssumptions({ ...settings.assumptions, ...(options.overrides ?? {}) });
  } catch {
    assumptions = validateAssumptions({ ...(options.overrides ?? {}) });
    assumptionNote = 'Stored assumptions were invalid and were replaced by the defaults.';
  }
  const costPct = estimateCarry(0, assumptions).costPct;

  const funding = await latestByVenue(db, 'funding_current_8h');
  const marks = await latestByVenue(db, 'perp_mark_price_usd');
  const indexes = await latestByVenue(db, 'index_price_usd');
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const settled = await fundingSamples(db, 'funding_settled_8h', since, now);
  const sampled = await fundingSamples(db, 'funding_current_8h', since, now);

  const venues: FundingVenueView[] = funding.map(row => {
    const meta = parseMeta(row);
    const rate8h = Number(row.value);
    const age = ageHours(row.observed_at, now);
    const settledSamples = settled.get(row.venue) ?? [];
    const sampledSamples = sampled.get(row.venue) ?? [];
    const useSettled = settledSamples.length >= 3;
    const persistence = persistenceView(useSettled ? settledSamples : sampledSamples, useSettled ? 'settled' : 'sampled');
    const mark = marks.find(candidate => candidate.venue === row.venue);
    const index = indexes.find(candidate => candidate.venue === row.venue);
    return {
      venue: row.venue,
      funding_8h: rate8h,
      funding_8h_pct: rate8h * 100,
      interval_hours: typeof meta.interval_hours === 'number' ? meta.interval_hours : null,
      observed_at: row.observed_at,
      age_hours: age,
      stale: age > 3,
      mark_price_usd: mark ? Number(mark.value) : null,
      index_price_usd: index ? Number(index.value) : null,
      carry: carryView(estimateCarry(rate8h, assumptions, typeof meta.interval_hours === 'number' ? meta.interval_hours : 8)),
      persistence,
      limitations: VENUE_LIMITATIONS[row.venue] ?? ['Jurisdiction, contract specifications, and liquidity have not been reviewed for this venue.'],
    };
  }).sort((a, b) => a.venue.localeCompare(b.venue));

  const basisRows = await latestByVenue(db, 'dated_future_mark_usd');
  const basis: BasisView[] = [];
  for (const row of basisRows) {
    const meta = parseMeta(row);
    const expiry = typeof meta.expiry === 'string' ? meta.expiry : null;
    const indexUsd = typeof meta.index_usd === 'number' ? meta.index_usd : null;
    if (!expiry || indexUsd === null) continue;
    const days = daysBetween(row.observed_at, expiry);
    if (days === null) continue;
    if (Date.parse(expiry) - now.getTime() < 12 * 3_600_000) continue;
    const estimate = basisAnnualized({ mark: Number(row.value), index: indexUsd, daysToExpiry: days });
    if (!estimate) continue;
    const age = ageHours(row.observed_at, now);
    basis.push({
      venue: row.venue, instrument: typeof meta.instrument === 'string' ? meta.instrument : row.venue,
      expiry, days_to_expiry: Math.round(days * 100) / 100,
      mark_usd: Number(row.value), index_usd: indexUsd,
      basis_pct: estimate.basisPct, annualized_pct: estimate.annualizedPct,
      cost_apr_pct: costPct * 365 / days, net_annualized_pct: (estimate.basisPct - costPct) * 365 / days,
      observed_at: row.observed_at, stale: age > 3,
    });
  }
  basis.sort((a, b) => b.net_annualized_pct - a.net_annualized_pct);

  const usableFunding = venues.filter(venue => !venue.stale && venue.carry);
  const bestFunding = usableFunding.length
    ? usableFunding.reduce((best, venue) => (venue.carry!.net_apr_pct > best.carry!.net_apr_pct ? venue : best))
    : null;
  const usableBasis = basis.filter(row => !row.stale);
  const bestBasis = usableBasis[0] ?? null;

  return {
    generated_at: now.toISOString(),
    assumptions, assumption_note: assumptionNote,
    venues, basis,
    best_funding: bestFunding ? { venue: bestFunding.venue, net_apr_pct: bestFunding.carry!.net_apr_pct } : null,
    best_basis: bestBasis ? { venue: bestBasis.venue, instrument: bestBasis.instrument, net_annualized_pct: bestBasis.net_annualized_pct } : null,
    disclaimer: 'Indicative research only. Annualized figures assume the rate persists and that the position can be opened and closed at the stated costs. They are not guaranteed income, they ignore margin, funding-interval changes, contract specification, counterparty, custody, and jurisdiction risk, and this instrument never trades.',
  };
}

export interface EvidenceHypothesisLink { id: string; effect: string }

export interface EvidenceItem {
  id: string;
  kind: string;
  title: string;
  summary: string;
  occurred_at: string;
  jurisdiction: string | null;
  status: string;
  direction: string;
  importance: string;
  source_title: string;
  source_url: string;
  published_at: string | null;
  retrieved_at: string;
  review_status: string;
  reviewed_at: string | null;
  created_at: string;
  hypotheses: EvidenceHypothesisLink[];
}

export interface EvidenceQuery {
  q?: string;
  kind?: string;
  status?: string;
  review?: string;
  limit?: number;
  offset?: number;
}

const EVIDENCE_KINDS = ['treasury', 'retention', 'lightning', 'settlement', 'regulation', 'market', 'contradiction'];
const EVIDENCE_STATUSES = ['proposed', 'authorized', 'pilot', 'effective', 'activity', 'market'];
const EVIDENCE_REVIEW = ['unreviewed', 'verified', 'rejected'];
export const EVIDENCE_FILTERS = { kinds: EVIDENCE_KINDS, statuses: EVIDENCE_STATUSES, reviews: EVIDENCE_REVIEW };

// Searchable timeline. The filter fragments are fixed strings and every value is
// bound, so no caller input becomes SQL.
export async function evidenceList(db: D1Database, query: EvidenceQuery = {}): Promise<{ items: EvidenceItem[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const offset = Math.min(Math.max(Number(query.offset ?? 0), 0), 10_000);
  const where: string[] = [];
  const binds: unknown[] = [];
  const search = (query.q ?? '').trim().slice(0, 100);
  if (search) {
    where.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(summary), lower(?)) > 0 OR instr(lower(source_title), lower(?)) > 0)');
    binds.push(search, search, search);
  }
  if (query.kind && EVIDENCE_KINDS.includes(query.kind)) { where.push('kind = ?'); binds.push(query.kind); }
  if (query.status && EVIDENCE_STATUSES.includes(query.status)) { where.push('status = ?'); binds.push(query.status); }
  if (query.review && EVIDENCE_REVIEW.includes(query.review)) { where.push('review_status = ?'); binds.push(query.review); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM bs_evidence ${clause}`).bind(...binds).first<{ n: number }>();
  const { results } = await db.prepare(
    `SELECT * FROM bs_evidence ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset).all<Omit<EvidenceItem, 'hypotheses'>>();
  const ids = results.map(row => row.id);
  const links = new Map<string, EvidenceHypothesisLink[]>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const linked = await db.prepare(
      `SELECT evidence_id, hypothesis_id, effect FROM bs_evidence_hypotheses WHERE evidence_id IN (${placeholders}) ORDER BY hypothesis_id`)
      .bind(...ids).all<{ evidence_id: string; hypothesis_id: string; effect: string }>();
    for (const link of linked.results) {
      const list = links.get(link.evidence_id) ?? [];
      list.push({ id: link.hypothesis_id, effect: link.effect });
      links.set(link.evidence_id, list);
    }
  }
  return {
    items: results.map(row => ({ ...row, hypotheses: links.get(row.id) ?? [] })),
    total: Number(count?.n ?? 0), limit, offset,
  };
}

export interface OpenAlert {
  id: string;
  rule_id: string;
  severity: string;
  title: string;
  detail: string;
  observed_value: number | null;
  threshold: number | null;
  created_at: string;
  acknowledged_at: string | null;
  deliveries: number;
}

export async function alertsView(db: D1Database, limit = 20): Promise<OpenAlert[]> {
  const { results } = await db.prepare(
    `SELECT a.id, a.rule_id, a.severity, a.title, a.detail, a.observed_value, a.threshold, a.created_at, a.acknowledged_at,
       (SELECT COUNT(*) FROM bs_alert_deliveries d WHERE d.alert_id = a.id) AS deliveries
     FROM bs_alerts a WHERE ${reportableAlertsSql('a')} ORDER BY a.created_at DESC LIMIT ?`).bind(Math.min(Math.max(limit, 1), 100))
    .all<OpenAlert>();
  return results.map(row => ({ ...row, deliveries: Number(row.deliveries) }));
}

export interface BackupView {
  recorded: boolean;
  checked_at: string | null;
  age_hours: number | null;
  ok: boolean | null;
  max_age_hours: number | null;
  source: string | null;
  note: string;
}

// Backup status is an attested reading of the read-only backup-status report. The
// Worker has no backup-bucket credential, so "unknown" is reported honestly
// instead of guessing that a backup exists.
export async function backupView(db: D1Database, now = new Date()): Promise<BackupView> {
  const row = await db.prepare('SELECT checked_at, ok, max_age_hours, source, report_json FROM bs_backup_checks ORDER BY checked_at DESC LIMIT 1')
    .first<{ checked_at: string; ok: number; max_age_hours: number; source: string; report_json: string }>();
  if (!row) {
    return { recorded: false, checked_at: null, age_hours: null, ok: null, max_age_hours: null, source: null, note: 'No backup verification has been recorded. Run scripts/backup/backup-status.mjs and record its report in Settings.' };
  }
  const age = ageHours(row.checked_at, now);
  const report = JSON.parse(row.report_json) as { captured_at?: string }[];
  const fresh = Number(row.ok) === 1 && report.length === 3 && report.every(entry => {
    const captured = Date.parse(entry.captured_at ?? '');
    const elapsed = now.getTime() - captured;
    return Number.isFinite(captured) && elapsed >= 0 && elapsed <= Number(row.max_age_hours) * 3_600_000;
  });
  return {
    recorded: true, checked_at: row.checked_at, age_hours: age, ok: fresh,
    max_age_hours: Number(row.max_age_hours), source: row.source,
    note: fresh ? `The attested backups for all three databases are within ${Number(row.max_age_hours)}h.` : 'The attestation is stale or reports a database without a fresh verified backup.',
  };
}

export function csvEscape(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Quoting CSV syntax alone does not prevent spreadsheet formula execution.
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportObservationsCsv(db: D1Database, { series, limit = 5000 }: { series?: string; limit?: number } = {}): Promise<string> {
  const bounded = Math.min(Math.max(limit, 1), 5000);
  const { results } = series
    ? await db.prepare(`SELECT source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, tier, revision, run_id, meta_json FROM bs_observations WHERE series = ? AND ${REPORTABLE_OBSERVATIONS_SQL} ORDER BY observed_at DESC LIMIT ?`).bind(series, bounded).all<Record<string, unknown>>()
    : await db.prepare(`SELECT source_id, source_url, series, venue, observed_at, retrieved_at, value, unit, tier, revision, run_id, meta_json FROM bs_observations WHERE ${REPORTABLE_OBSERVATIONS_SQL} ORDER BY id DESC LIMIT ?`).bind(bounded).all<Record<string, unknown>>();
  const columns = ['source_id', 'source_url', 'series', 'venue', 'observed_at', 'retrieved_at', 'value', 'unit', 'tier', 'revision', 'run_id', 'meta_json'];
  return [columns.join(','), ...results.map(row => columns.map(column => csvEscape(row[column])).join(','))].join('\n') + '\n';
}

export async function exportEvidenceCsv(db: D1Database, limit = 5000): Promise<string> {
  const bounded = Math.min(Math.max(limit, 1), 5000);
  const { results } = await db.prepare(
    'SELECT id, kind, title, summary, occurred_at, jurisdiction, status, direction, importance, source_title, source_url, published_at, retrieved_at, review_status, reviewed_at FROM bs_evidence ORDER BY occurred_at DESC LIMIT ?')
    .bind(bounded).all<Record<string, unknown>>();
  const columns = ['id', 'kind', 'title', 'summary', 'occurred_at', 'jurisdiction', 'status', 'direction', 'importance', 'source_title', 'source_url', 'published_at', 'retrieved_at', 'review_status', 'reviewed_at'];
  return [columns.join(','), ...results.map(row => columns.map(column => csvEscape(row[column])).join(','))].join('\n') + '\n';
}
