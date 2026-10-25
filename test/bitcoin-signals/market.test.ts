import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSUMPTIONS, PERIODS_PER_YEAR, annualizeFunding, basisAnnualized, daysBetween,
  estimateCarry, inferFundingIntervalHours, isStale, normalizeToEightHours, persistenceStats, validateAssumptions,
} from '../../src/bitcoin-signals/market';

describe('funding units and annualization', () => {
  it('annualizes an 8-hour rate over 1095 periods, not 3 per day', () => {
    expect(PERIODS_PER_YEAR).toBe(1095);
    const { aprPct, apyPct } = annualizeFunding(0.0001);
    expect(aprPct).toBeCloseTo(10.95, 6); // 1 bp per 8h
    expect(apyPct).not.toBeNull();
    expect(apyPct!).toBeGreaterThan(aprPct);
  });

  it('normalizes a 4-hour venue to the 8-hour unit and rejects unknown intervals', () => {
    expect(normalizeToEightHours(0.00005, 4)).toBeCloseTo(0.0001, 12);
    expect(normalizeToEightHours(0.0001, 8)).toBeCloseTo(0.0001, 12);
    expect(normalizeToEightHours(0.0001, 3)).toBeNull();
    expect(normalizeToEightHours(Number.NaN, 8)).toBeNull();
  });

  it('handles negative rates symmetrically without hiding the loss', () => {
    const negative = annualizeFunding(-0.0001);
    expect(negative.aprPct).toBeCloseTo(-10.95, 6);
    expect(negative.apyPct).not.toBeNull();
    // Compounding a loss is still a loss, but smaller in magnitude than simple APR.
    expect(negative.apyPct!).toBeGreaterThan(negative.aprPct);
    expect(negative.apyPct!).toBeLessThan(0);
    expect(annualizeFunding(-1).apyPct).toBeNull();
  });

  it('compounds APY at the native settlement interval after normalizing APR', () => {
    const annualized = annualizeFunding(0.00008, 1);
    expect(annualized.aprPct).toBeCloseTo(0.00001 * 8760 * 100, 10);
    expect(annualized.apyPct).toBeCloseTo((Math.pow(1.00001, 8760) - 1) * 100, 10);
    expect(annualizeFunding(0.0001, 3).apyPct).toBeNull();
  });
});

describe('carry after realistic costs', () => {
  it('deducts fees and slippage on every leg and reports a breakeven', () => {
    const carry = estimateCarry(0.0001, { feeBpsPerLeg: 2, slippageBpsPerLeg: 1, legs: 4, holdingDays: 30 });
    // 3 bps x 4 legs = 12 bps one-time; spread over 30 days = 1.46% annualized.
    expect(carry.costPct).toBeCloseTo(0.12, 10);
    expect(carry.costAprPct).toBeCloseTo(0.12 * (365 / 30), 8);
    expect(carry.netAprPct).toBeCloseTo(carry.grossAprPct - carry.costAprPct, 10);
    expect(carry.holdingReturnPct).toBeCloseTo(0.0001 * 90 * 100, 10); // 90 periods in 30 days
    expect(carry.breakevenPeriods).toBeCloseTo(12, 10); // 12 bps of cost / 1 bp per period
    expect(carry.profitable).toBe(true);
  });

  it('reports no breakeven and no profit for negative funding', () => {
    const carry = estimateCarry(-0.0002, DEFAULT_ASSUMPTIONS);
    expect(carry.netAprPct).toBeLessThan(0);
    expect(carry.netHoldingPct).toBeLessThan(0);
    expect(carry.breakevenPeriods).toBeNull();
    expect(carry.profitable).toBe(false);
  });

  it('a higher cost assumption can make a positive rate unprofitable', () => {
    const carry = estimateCarry(0.0001, { feeBpsPerLeg: 5, slippageBpsPerLeg: 5, legs: 4, holdingDays: 1 });
    expect(carry.grossAprPct).toBeGreaterThan(0);
    expect(carry.netAprPct).toBeLessThan(0);
  });

  it('validates operator assumptions strictly', () => {
    expect(validateAssumptions({ feeBpsPerLeg: 3 })).toEqual({ ...DEFAULT_ASSUMPTIONS, feeBpsPerLeg: 3 });
    expect(() => validateAssumptions({ holdingDays: 0 })).toThrow(/holdingDays/);
    expect(() => validateAssumptions({ legs: 2.5 })).toThrow(/legs/);
    expect(() => validateAssumptions({ fee_bps_per_leg: 2 })).toThrow(/unknown assumption/);
    expect(() => validateAssumptions({ feeBpsPerLeg: 100_000 })).toThrow(/feeBpsPerLeg/);
  });
});

describe('basis', () => {
  it('annualizes the premium over the exact time to expiry', () => {
    const basis = basisAnnualized({ mark: 101, index: 100, daysToExpiry: 90 });
    expect(basis).not.toBeNull();
    expect(basis!.basisPct).toBeCloseTo(1, 10);
    expect(basis!.annualizedPct).toBeCloseTo((1 * 365) / 90, 8);
  });

  it('refuses a contract inside its final hours or with a bad price', () => {
    expect(basisAnnualized({ mark: 101, index: 100, daysToExpiry: 0.01 })).toBeNull();
    expect(basisAnnualized({ mark: 0, index: 100, daysToExpiry: 30 })).toBeNull();
    expect(basisAnnualized({ mark: 101, index: 0, daysToExpiry: 30 })).toBeNull();
    expect(basisAnnualized({ mark: Number.NaN, index: 100, daysToExpiry: 30 })).toBeNull();
  });

  it('computes time to expiry and rejects a past date', () => {
    expect(daysBetween('2026-10-25T00:00:00.000Z', '2026-11-24T00:00:00.000Z')).toBeCloseTo(30, 6);
    expect(daysBetween('2026-10-25T00:00:00.000Z', '2026-10-24T00:00:00.000Z')).toBeNull();
    expect(daysBetween('not a date', '2026-11-24T00:00:00.000Z')).toBeNull();
  });
});

describe('persistence and freshness', () => {
  it('deduplicates repeated timestamps so a re-collection cannot inflate the sample count', () => {
    const stats = persistenceStats([
      { observedAt: '2026-10-24T00:00:00.000Z', rate8h: 0.0001 },
      { observedAt: '2026-10-24T00:00:00.000Z', rate8h: 0.0001 },
      { observedAt: '2026-10-24T08:00:00.000Z', rate8h: -0.0002 },
      { observedAt: '2026-10-24T16:00:00.000Z', rate8h: 0.0003 },
    ]);
    expect(stats.samples).toBe(3);
    expect(stats.positiveShare).toBeCloseTo(2 / 3, 10);
    expect(stats.negativeShare).toBeCloseTo(1 / 3, 10);
    expect(stats.mean8hPct).toBeCloseTo(((0.0001 - 0.0002 + 0.0003) / 3) * 100, 12);
    expect(stats.median8hPct).toBeCloseTo(0.01, 12);
    expect(stats.coverageHours).toBe(16);
  });

  it('counts the longest positive and negative runs in chronological order', () => {
    const stats = persistenceStats([
      { observedAt: '2026-10-24T00:00:00.000Z', rate8h: 0.0001 },
      { observedAt: '2026-10-24T08:00:00.000Z', rate8h: 0.0002 },
      { observedAt: '2026-10-24T16:00:00.000Z', rate8h: 0.0003 },
      { observedAt: '2026-10-25T00:00:00.000Z', rate8h: -0.0001 },
      { observedAt: '2026-10-25T08:00:00.000Z', rate8h: -0.0002 },
    ]);
    expect(stats.longestPositiveRun).toBe(3);
    expect(stats.longestNegativeRun).toBe(2);
    expect(stats.coverageHours).toBe(32);
    expect(stats.cumulativePct).toBeCloseTo((0.0001 + 0.0002 + 0.0003 - 0.0001 - 0.0002) * 100, 12);
  });

  it('returns an empty result rather than a fabricated one', () => {
    const stats = persistenceStats([]);
    expect(stats.samples).toBe(0);
    expect(stats.mean8hPct).toBeNull();
    expect(stats.coverageHours).toBe(0);
  });

  it('infers the common funding interval from settlement timestamps', () => {
    const eight = [0, 8, 16, 24, 32].map(hours => Date.UTC(2026, 9, 24) + hours * 3_600_000);
    expect(inferFundingIntervalHours(eight)).toBe(8);
    const four = [0, 4, 8, 12, 16, 20].map(hours => Date.UTC(2026, 9, 24) + hours * 3_600_000);
    expect(inferFundingIntervalHours(four)).toBe(4);
    expect(inferFundingIntervalHours([])).toBeNull();
    expect(inferFundingIntervalHours([0, 8.4 * 3_600_000])).toBeNull();
    expect(inferFundingIntervalHours([0, 4 * 3_600_000, 12 * 3_600_000])).toBeNull();
  });

  it('sums actual payouts when settlements have shorter source intervals', () => {
    const stats = persistenceStats([
      { observedAt: '2026-10-24T00:00:00.000Z', rate8h: 0.0002, intervalHours: 4 },
      { observedAt: '2026-10-24T04:00:00.000Z', rate8h: 0.0004, intervalHours: 4 },
    ]);
    expect(stats.cumulativePct).toBeCloseTo(0.03, 12);
  });

  it('marks a quote stale by observation age, not by retrieval time', () => {
    expect(isStale('2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z', 3)).toBe(false);
    expect(isStale('2026-10-24T00:00:00.000Z', '2026-10-25T01:00:00.000Z', 3)).toBe(true);
    expect(isStale('bad', '2026-10-25T01:00:00.000Z')).toBe(true);
  });
});
