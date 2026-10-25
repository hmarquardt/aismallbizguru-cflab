// Funding and basis arithmetic for the arbitrage view.
//
// Units and conventions are fixed here so every venue is comparable:
//   * every stored funding rate is a decimal fraction per 8-hour period
//     (`0.0001` = 1 basis point per 8h), normalized from the venue's own interval;
//   * annualization is 365 days of 8-hour periods (1095 periods), never 3x daily;
//   * costs are deducted from the annualized rate over an explicit holding window,
//     and a theoretical annualized number is never presented as guaranteed income.
//
// Nothing here reads a database or the network: these are pure functions covered
// by test/bitcoin-signals/market.test.ts.

export const FUNDING_PERIOD_HOURS = 8;
export const PERIODS_PER_YEAR = (365 * 24) / FUNDING_PERIOD_HOURS;
export const MAX_FUNDING_RATE_8H = 0.05; // 5% per 8h is a sanity ceiling, not a market view
export const VALID_FUNDING_INTERVALS = [1, 2, 4, 8] as const;

export interface CarryAssumptions {
  feeBpsPerLeg: number;
  slippageBpsPerLeg: number;
  legs: number;
  holdingDays: number;
}

export const DEFAULT_ASSUMPTIONS: CarryAssumptions = {
  feeBpsPerLeg: 2, slippageBpsPerLeg: 1, legs: 4, holdingDays: 30,
};

const LIMITS = {
  feeBpsPerLeg: [0, 500],
  slippageBpsPerLeg: [0, 500],
  legs: [1, 8],
  holdingDays: [1, 365],
} as const;

function boundedInteger(value: unknown, name: keyof typeof LIMITS): number {
  const [min, max] = LIMITS[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

// Strict validation for operator-supplied assumptions: unknown fields, floats
// where an integer is required, and out-of-range values are all rejected rather
// than silently clamped.
export function validateAssumptions(input: Record<string, unknown>): CarryAssumptions {
  const allowed = new Set(Object.keys(DEFAULT_ASSUMPTIONS));
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`unknown assumption: ${unknown.join(', ')}`);
  const merged = { ...DEFAULT_ASSUMPTIONS, ...input };
  return {
    feeBpsPerLeg: boundedInteger(merged.feeBpsPerLeg, 'feeBpsPerLeg'),
    slippageBpsPerLeg: boundedInteger(merged.slippageBpsPerLeg, 'slippageBpsPerLeg'),
    legs: boundedInteger(merged.legs, 'legs'),
    holdingDays: boundedInteger(merged.holdingDays, 'holdingDays'),
  };
}

export function isFundingIntervalHours(value: unknown): value is number {
  return typeof value === 'number' && (VALID_FUNDING_INTERVALS as readonly number[]).includes(value);
}

// Funding history often omits an explicit interval. Only an exact, consistent
// supported gap can establish it; missing or mixed intervals are never guessed.
export function inferFundingIntervalHours(timestampsMs: number[]): number | null {
  const unique = [...new Set(timestampsMs.filter(value => Number.isFinite(value)))].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let index = 1; index < unique.length; index += 1) {
    const hours = (unique[index]! - unique[index - 1]!) / 3_600_000;
    if (!isFundingIntervalHours(hours)) return null;
    counts.set(hours, (counts.get(hours) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [hours, count] of counts) {
    if (count > bestCount) { best = hours; bestCount = count; }
  }
  return counts.size === 1 ? best : null;
}

// A venue that pays every 4 hours charges twice per 8-hour period, so its rate is
// doubled to express the same 8-hour unit. Invalid intervals return null: an
// unknown interval is not guessed.
export function normalizeToEightHours(rate: number, intervalHours: number): number | null {
  if (!Number.isFinite(rate) || !isFundingIntervalHours(intervalHours)) return null;
  return rate * (FUNDING_PERIOD_HOURS / intervalHours);
}

export interface AnnualizedFunding { aprPct: number; apyPct: number | null }

// APR is the simple annualization used for comparison; APY compounds the same
// periodic rate. Negative rates annualize symmetrically: APY stays above APR
// because losing less through compounding is still a loss.
export function annualizeFunding(rate8h: number, intervalHours = 8): AnnualizedFunding {
  const aprPct = rate8h * PERIODS_PER_YEAR * 100;
  const base = 1 + rate8h * intervalHours / FUNDING_PERIOD_HOURS;
  const apyPct = isFundingIntervalHours(intervalHours) && base > 0 ? (Math.pow(base, 365 * 24 / intervalHours) - 1) * 100 : null;
  return { aprPct, apyPct };
}

export interface CarryEstimate {
  grossAprPct: number;
  grossApyPct: number | null;
  holdingReturnPct: number;
  costPct: number;
  costAprPct: number;
  netAprPct: number;
  netHoldingPct: number;
  breakevenPeriods: number | null;
  profitable: boolean;
}

// `costPct` is the one-time round-trip cost (fees + slippage on every leg);
// `costAprPct` spreads it over the holding window so it can be compared with the
// annualized funding rate. Costs are not compounded.
export function estimateCarry(rate8h: number, assumptions: CarryAssumptions = DEFAULT_ASSUMPTIONS, intervalHours = 8): CarryEstimate {
  const { aprPct, apyPct } = annualizeFunding(rate8h, intervalHours);
  const periodsInHolding = (assumptions.holdingDays * 24) / FUNDING_PERIOD_HOURS;
  const holdingReturnPct = rate8h * periodsInHolding * 100;
  const costPct = ((assumptions.feeBpsPerLeg + assumptions.slippageBpsPerLeg) * assumptions.legs) / 10_000 * 100;
  const costAprPct = costPct * (365 / assumptions.holdingDays);
  const netAprPct = aprPct - costAprPct;
  return {
    grossAprPct: aprPct,
    grossApyPct: apyPct,
    holdingReturnPct,
    costPct,
    costAprPct,
    netAprPct,
    netHoldingPct: holdingReturnPct - costPct,
    // With a negative or zero rate no amount of time recovers the cost.
    breakevenPeriods: rate8h > 0 ? costPct / (rate8h * 100) : null,
    profitable: netAprPct > 0,
  };
}

export interface BasisEstimate { basisPct: number; annualizedPct: number }

// A contract inside its final half-day is refused rather than annualized: the
// denominator would turn a rounding difference into a triple-digit percentage.
export const MIN_DAYS_TO_EXPIRY = 0.5;

// Cash-and-carry basis for a dated contract: futures premium over the venue's own
// index, annualized over the exact time to expiry.
export function basisAnnualized({ mark, index, daysToExpiry }: { mark: number; index: number; daysToExpiry: number }): BasisEstimate | null {
  if (!Number.isFinite(mark) || !Number.isFinite(index) || !Number.isFinite(daysToExpiry)) return null;
  if (mark <= 0 || index <= 0 || daysToExpiry < MIN_DAYS_TO_EXPIRY) return null;
  const basisPct = (mark / index - 1) * 100;
  return { basisPct, annualizedPct: basisPct * (365 / daysToExpiry) };
}

export function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / 86_400_000;
}

export interface FundingSample { observedAt: string; rate8h: number; intervalHours?: number }

export interface PersistenceStats {
  samples: number;
  firstAt: string | null;
  lastAt: string | null;
  coverageHours: number;
  mean8hPct: number | null;
  median8hPct: number | null;
  positiveShare: number | null;
  negativeShare: number | null;
  longestPositiveRun: number;
  longestNegativeRun: number;
  cumulativePct: number | null;
}

// Persistence is measured from retained history, deduplicated by observation time
// so a repeated collection cannot inflate the sample count. The cumulative figure
// is the simple sum of per-period rates, not a compounded return.
export function persistenceStats(samples: FundingSample[]): PersistenceStats {
  const byTime = new Map<string, number>();
  const payouts = new Map<string, number>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.rate8h)) continue;
    if (!Number.isFinite(Date.parse(sample.observedAt))) continue;
    byTime.set(sample.observedAt, sample.rate8h);
    payouts.set(sample.observedAt, sample.rate8h * (sample.intervalHours ?? 8) / 8);
  }
  const ordered = [...byTime.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rates = ordered.map(entry => entry[1]);
  if (!rates.length) {
    return {
      samples: 0, firstAt: null, lastAt: null, coverageHours: 0, mean8hPct: null, median8hPct: null,
      positiveShare: null, negativeShare: null, longestPositiveRun: 0, longestNegativeRun: 0, cumulativePct: null,
    };
  }
  const sum = rates.reduce((total, rate) => total + rate, 0);
  const sorted = [...rates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  let run = 0; let longestPositiveRun = 0; let negativeRun = 0; let longestNegativeRun = 0;
  for (const rate of rates) {
    if (rate > 0) { run += 1; negativeRun = 0; } else if (rate < 0) { negativeRun += 1; run = 0; } else { run = 0; negativeRun = 0; }
    longestPositiveRun = Math.max(longestPositiveRun, run);
    longestNegativeRun = Math.max(longestNegativeRun, negativeRun);
  }
  const firstAt = ordered[0]![0];
  const lastAt = ordered[ordered.length - 1]![0];
  const coverageHours = Math.round(((Date.parse(lastAt) - Date.parse(firstAt)) / 3_600_000) * 100) / 100;
  const positives = rates.filter(rate => rate > 0).length;
  const negatives = rates.filter(rate => rate < 0).length;
  return {
    samples: rates.length,
    firstAt, lastAt, coverageHours,
    mean8hPct: (sum / rates.length) * 100,
    median8hPct: median * 100,
    positiveShare: positives / rates.length,
    negativeShare: negatives / rates.length,
    longestPositiveRun, longestNegativeRun,
    cumulativePct: [...payouts.values()].reduce((total, payout) => total + payout, 0) * 100,
  };
}

// A quote older than this many collection intervals is stale: it is shown with
// its age, excluded from cross-venue ranking, and never used for an alert.
export function isStale(observedAt: string, retrievedAt: string, maxAgeHours = 3): boolean {
  const observed = Date.parse(observedAt);
  const retrieved = Date.parse(retrievedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(retrieved)) return true;
  return retrieved - observed > maxAgeHours * 3_600_000;
}
