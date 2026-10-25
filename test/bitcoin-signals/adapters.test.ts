import { describe, expect, it } from 'vitest';
import { COLLECTORS } from '../../src/bitcoin-signals/sources';
import { validateObservation } from '../../src/bitcoin-signals/collector';
import { fixtures, NOW, URLS } from './fixtures';

// Parser tests retain disabled adapters without authorizing any network access.
// All input values are synthetic and remain inside this test process.
describe('offline adapters, including disabled providers', () => {
  it('preserves normalization, contract, timestamp and provenance checks for every adapter', async () => {
    const payloads = fixtures();
    const results = new Map<string, Awaited<ReturnType<typeof COLLECTORS[number]['collect']>>>();
    for (const adapter of COLLECTORS) {
      const rows = await adapter.collect(async url => {
        expect(url in payloads).toBe(true);
        return payloads[url];
      }, NOW);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(validateObservation(row, adapter, NOW).ok).toBe(true);
      results.set(adapter.id, rows);
    }
    const okx = results.get('okx')!;
    expect(okx.find(row => row.series === 'funding_current_8h')?.value).toBeCloseTo(0.00006, 12);
    const settled = okx.filter(row => row.series === 'funding_settled_8h');
    expect(settled).toHaveLength(2);
    expect(settled.every(row => row.url === URLS.okxHistory)).toBe(true);
    expect(results.get('deribit')!.find(row => row.series === 'funding_current_8h')?.value).toBeCloseTo(0.000036, 12);
    const future = results.get('deribit')!.find(row => row.series === 'dated_future_mark_usd')!;
    expect(future.meta).toMatchObject({ family: 'deribit', instrument: 'BTC-27NOV26', index_usd: 80566.15 });
    const kraken = results.get('kraken-futures')!.find(row => row.series === 'funding_current_8h')!;
    expect(kraken.value).toBeCloseTo(0.0000105 * 8, 12);
    expect(kraken.meta?.interval_hours).toBe(1);
    const dated = results.get('kraken-futures')!.find(row => row.series === 'dated_future_mark_usd')!;
    expect(dated.venue).toBe('kraken-futures:FF_XBTUSD_261225');
    expect(dated.url ?? COLLECTORS.find(row => row.id === 'kraken-futures')!.url).toBe(URLS.krakenFutures);
    expect(results.get('coingecko-treasury')!.filter(row => row.series === 'treasury_company_btc')).toHaveLength(2);
    expect(results.get('coingecko-treasury')!.find(row => row.series === 'treasury_total_btc')?.value).toBe(1_303_574.21);
    expect(results.get('kraken-spot')![0]!.meta).toMatchObject({ observed_at_source: 'retrieval' });
  });

  it('still rejects an invalid OKX payload without making a request', async () => {
    await expect(COLLECTORS.find(adapter => adapter.id === 'okx')!.collect(async () => ({ code: '0', data: [{ fundingRate: 'bad' }] }), NOW)).rejects.toThrow();
  });
});
