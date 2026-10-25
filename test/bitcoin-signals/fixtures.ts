// Synthetic offline adapter payloads. Never fetched from or promoted to production.
const NOW = new Date('2026-10-25T16:00:00.000Z');
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;

const URLS = {
  okxFunding: 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP',
  okxHistory: 'https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100',
  okxSpot: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
  okxIndex: 'https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USDT',
  deribitPerp: 'https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL',
  deribitInstruments: 'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=future&expired=false',
  deribitBook: 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future',
  krakenFutures: 'https://futures.kraken.com/derivatives/api/v3/tickers',
  krakenSpot: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  coinbase: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
  mempool: 'https://mempool.space/api/v1/lightning/statistics/latest',
  coingecko: 'https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin',
};

function fixtures(): Record<string, unknown> {
  return {
    [URLS.okxFunding]: { code: '0', data: [{ fundingRate: '0.000060', fundingTime: String(NOW_MS), nextFundingTime: String(NOW_MS + 8 * HOUR), ts: String(NOW_MS - 30_000) }] },
    [URLS.okxHistory]: { code: '0', data: [
      { fundingRate: '0.00009', realizedRate: '0.00009', fundingTime: String(NOW_MS - 16 * HOUR) },
      { fundingRate: '0.00008', realizedRate: '0.00008', fundingTime: String(NOW_MS - 24 * HOUR) },
      { fundingRate: '0.00007', realizedRate: '0.00007', fundingTime: String(NOW_MS - 32 * HOUR) },
    ] },
    [URLS.okxSpot]: { code: '0', data: [{ last: '80500.5', ts: String(NOW_MS - 60_000) }] },
    [URLS.okxIndex]: { code: '0', data: [{ idxPx: '80490.25', ts: String(NOW_MS - 60_000) }] },
    [URLS.deribitPerp]: { jsonrpc: '2.0', result: { timestamp: NOW_MS - 30_000, funding_8h: 0.000036, index_price: 80566.15, mark_price: 80582.67 } },
    [URLS.deribitInstruments]: { jsonrpc: '2.0', result: [
      { instrument_name: 'BTC-PERPETUAL', expiration_timestamp: 32_503_708_800_000, settlement_period: 'perpetual', is_active: true },
      { instrument_name: 'BTC-27NOV26', expiration_timestamp: NOW_MS + 33 * 24 * HOUR, settlement_period: 'month', is_active: true },
      { instrument_name: 'BTC-25DEC26', expiration_timestamp: NOW_MS + 61 * 24 * HOUR, settlement_period: 'month', is_active: true },
    ] },
    [URLS.deribitBook]: { jsonrpc: '2.0', result: [
      { instrument_name: 'BTC-27NOV26', mark_price: 81000, estimated_delivery_price: 80566, creation_timestamp: NOW_MS - 20_000 },
      { instrument_name: 'BTC-25DEC26', mark_price: 81800, estimated_delivery_price: 80566, creation_timestamp: NOW_MS - 20_000 },
    ] },
    [URLS.krakenFutures]: { result: 'success', serverTime: NOW.toISOString(), tickers: [
      { symbol: 'PF_XBTUSD', relativeFundingRate: 0.0000105, fundingRate: 0.8467, indexPrice: 80559.9, markPrice: 80570.49 },
      { symbol: 'FF_XBTUSD_261225', markPrice: 81900, indexPrice: 80568.53 },
      { symbol: 'FF_XBTUSD_200000', markPrice: 1, indexPrice: 1 },
    ] },
    [URLS.krakenSpot]: { error: [], result: { XXBTZUSD: { c: ['80500.1', '0.2'] } } },
    [URLS.coinbase]: { price: '80560.61', time: new Date(NOW_MS - 45_000).toISOString() },
    [URLS.mempool]: { latest: { id: 147496, added: new Date(NOW_MS - 24 * HOUR).toISOString(), node_count: 15982, channel_count: 29673, total_capacity: 34_345_588_045_100 } },
    [URLS.coingecko]: {
      total_holdings: 1_303_574.21, total_value_usd: 105_051_464_196.05, market_cap_dominance: 6.21,
      companies: [
        { name: 'Strategy', symbol: 'MSTR.US', country: 'US', total_holdings: 848_517, total_entry_value_usd: 64_558_528_391, total_current_value_usd: 68_379_653_360, percentage_of_total_supply: 4.04 },
        { name: 'Metaplanet', symbol: '3350.T', country: 'JP', total_holdings: 44_000, total_entry_value_usd: 3_896_249_023, total_current_value_usd: 3_545_839_090, percentage_of_total_supply: 0.21 },
      ],
    },
  };
}

function stubFetch(overrides: Record<string, () => Response> = {}) {
  const table = fixtures();
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (overrides[url]) return overrides[url]!();
    if (!(url in table)) return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(table[url]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}


export { NOW, NOW_MS, HOUR, URLS, fixtures, stubFetch };
