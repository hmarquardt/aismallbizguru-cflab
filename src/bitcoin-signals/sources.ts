// The complete, server-side source allowlist for Bitcoin Signals.
//
// Every request this module makes is a fixed HTTPS URL built from a constant in
// this file. No caller-supplied URL, host, path, query, header, or credential
// reaches a fetch. Responses are validated field by field: a shape change or a
// nonsense value fails that one source instead of writing corrupt history.
//
// One source needs a credential: CoinGecko's Demo API answers HTTP 429 to
// unauthenticated traffic. The key is read from the Worker secret binding named
// below and travels only in an outbound request header, so it never appears in a
// URL, query string, stored row, log line, export, or response.

import type { Bindings } from '../types';
import { MAX_FUNDING_RATE_8H, inferFundingIntervalHours, isFundingIntervalHours, normalizeToEightHours } from './market';
import { isSourceEnabled } from './policy';

export type Tier = 'measured' | 'reported' | 'estimated' | 'curated';
export type Cadence = 'hourly' | 'daily' | 'curated';

export interface SeriesMeta {
  label: string;
  unit: string;
  tier: Tier;
  group: 'price' | 'funding' | 'lightning' | 'treasury';
  definition: string;
  /** How old an observation may be before it is shown as stale. */
  staleAfterHours: number;
  /** True when a chart of the retained history is useful on the radar. */
  chart: boolean;
}

// The measurement definition lives with the series, not with the caller, so every
// stored row carries the same unit and meaning.
export const SERIES = {
  spot_price_usd: {
    label: 'Spot price', unit: 'USD per BTC', tier: 'measured', group: 'price', staleAfterHours: 3, chart: true,
    definition: 'Last traded price of one bitcoin in USD on the named spot venue at the source-reported trade time.',
  },
  index_price_usd: {
    label: 'Index price', unit: 'USD per BTC', tier: 'measured', group: 'price', staleAfterHours: 3, chart: false,
    definition: 'The venue-published spot index that its derivatives settle against. Not a traded price.',
  },
  perp_mark_price_usd: {
    label: 'Perpetual mark', unit: 'USD per BTC', tier: 'measured', group: 'price', staleAfterHours: 3, chart: false,
    definition: 'The venue-published mark price of the BTC perpetual contract.',
  },
  funding_current_8h: {
    label: 'Funding rate', unit: 'fraction per 8h', tier: 'measured', group: 'funding', staleAfterHours: 3, chart: true,
    definition: 'Current or most recently published perpetual funding rate, normalized to a decimal fraction per 8-hour period. Positive means longs pay shorts. A prediction before settlement is not realized income.',
  },
  funding_settled_8h: {
    label: 'Settled funding', unit: 'fraction per 8h', tier: 'measured', group: 'funding', staleAfterHours: 24, chart: true,
    definition: 'Funding rate actually settled at the recorded time for the preceding interval, normalized to a decimal fraction per 8-hour period.',
  },
  dated_future_mark_usd: {
    label: 'Dated future mark', unit: 'USD per BTC', tier: 'measured', group: 'price', staleAfterHours: 3, chart: false,
    definition: 'Mark price of a dated BTC futures contract. Basis is computed against the same venue index at read time.',
  },
  lightning_node_count: {
    label: 'Lightning nodes', unit: 'nodes', tier: 'reported', group: 'lightning', staleAfterHours: 192, chart: true,
    definition: 'Publicly announced Lightning Network nodes, as aggregated by mempool.space from public gossip. Private nodes are not counted.',
  },
  lightning_channel_count: {
    label: 'Lightning channels', unit: 'channels', tier: 'reported', group: 'lightning', staleAfterHours: 192, chart: true,
    definition: 'Publicly announced Lightning channels, as aggregated by mempool.space. Channel count is not payment count.',
  },
  lightning_capacity_btc: {
    label: 'Lightning capacity', unit: 'BTC', tier: 'reported', group: 'lightning', staleAfterHours: 192, chart: true,
    definition: 'Total public channel capacity in BTC, as aggregated by mempool.space. Capacity is capital parked in channels, not payment volume.',
  },
  treasury_company_btc: {
    label: 'Treasury holdings', unit: 'BTC', tier: 'reported', group: 'treasury', staleAfterHours: 48, chart: false,
    definition: 'Bitcoin reported as held by one public company in the CoinGecko aggregation of public disclosures. A reported figure, not an audit by CFLab.',
  },
  treasury_total_btc: {
    label: 'Public-company treasury total', unit: 'BTC', tier: 'reported', group: 'treasury', staleAfterHours: 48, chart: true,
    definition: 'Sum of reported bitcoin holdings across the public companies in the CoinGecko dataset. Excludes private companies and sovereigns.',
  },
  treasury_total_usd: {
    label: 'Public-company treasury value', unit: 'USD', tier: 'reported', group: 'treasury', staleAfterHours: 48, chart: true,
    definition: 'Current USD value of the holdings in the CoinGecko public-company dataset, computed by CoinGecko at its own price.',
  },
  treasury_market_cap_dominance_pct: {
    label: 'Treasury share of market cap', unit: 'percent', tier: 'reported', group: 'treasury', staleAfterHours: 48, chart: false,
    definition: 'CoinGecko market-cap dominance of the public-company holdings it tracks. A percentage of market capitalization, not of supply.',
  },
} as const satisfies Record<string, SeriesMeta>;

export type SeriesKey = keyof typeof SERIES;

export interface RawObservation {
  series: SeriesKey;
  venue: string;
  observedAt: string;
  value: number;
  /** The exact URL this measurement came from; defaults to the collector's primary URL. */
  url?: string;
  meta?: Record<string, unknown>;
}

export type FetchJson = (url: string) => Promise<unknown>;

export interface Collector {
  id: string;
  cadence: 'hourly' | 'daily';
  /** Primary documented endpoint, used as the evidence URL when a row names none. */
  url: string;
  collect(fetchJson: FetchJson, now: Date): Promise<RawObservation[]>;
}

// Credentials are held by name: the binding and the header are both constants in
// this file, and the value comes only from the Worker environment. Nothing here
// accepts a caller-provided credential.
const SOURCE_CREDENTIALS: Readonly<Record<string, { header: string; env: keyof Bindings }>> = {
  'coingecko-treasury': { header: 'x-cg-demo-api-key', env: 'COINGECKO_DEMO_API_KEY' },
};

// Returns the outbound credential headers for one source. A source with no
// registered credential gets none. A registered credential that is missing or
// blank fails that source alone with a stable code, before any request is made,
// so an unconfigured key can never look like a provider outage or a rate limit.
export function sourceRequestHeaders(sourceId: string, env: Pick<Bindings, 'COINGECKO_DEMO_API_KEY'>): Record<string, string> {
  const credential = Object.hasOwn(SOURCE_CREDENTIALS, sourceId) ? SOURCE_CREDENTIALS[sourceId]! : null;
  if (!credential) return {};
  const value = (env as Record<string, unknown>)[credential.env];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SourcePayloadError('missing_credential', 'the source requires a configured API key');
  }
  return { [credential.header]: value.trim() };
}

export class SourcePayloadError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'SourcePayloadError';
  }
}

// Exact hostnames only. A subdomain, suffix, or redirect target is not implicitly
// trusted: a host outside this set is refused before a request is attempted.
const SOURCE_HOSTS: Readonly<Record<string, string>> = {
  okx: 'www.okx.com', deribit: 'www.deribit.com', 'kraken-futures': 'futures.kraken.com',
  'kraken-spot': 'api.kraken.com', 'coinbase-spot': 'api.exchange.coinbase.com',
  'mempool-space': 'mempool.space', 'coingecko-treasury': 'api.coingecko.com',
};
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(Object.values(SOURCE_HOSTS));

// A credential header is accepted only for the host that its own source owns, so
// a mistake or a future adapter cannot forward the key to another provider.
const AUTH_HEADERS_BY_HOST: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(SOURCE_CREDENTIALS).map(([sourceId, credential]) => [SOURCE_HOSTS[sourceId], [credential.header]]),
);

export const MAX_RESPONSE_BYTES = 1_500_000;
export const SOURCE_TIMEOUT_MS = 8_000;

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourcePayloadError('shape', `${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new SourcePayloadError('shape', `${what} is not a JSON array`);
  return value;
}

function number(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new SourcePayloadError('shape', `${what} is not a finite number`);
  return parsed;
}

function timestampMs(value: unknown, what: string): number {
  const parsed = number(value, what);
  if (parsed < 1_000_000_000_000 || parsed > 4_102_444_800_000) throw new SourcePayloadError('shape', `${what} is not a plausible millisecond timestamp`);
  return parsed;
}

function isoFromMs(value: unknown, what: string): string {
  return new Date(timestampMs(value, what)).toISOString();
}

function price(value: unknown, what: string): number {
  const parsed = number(value, what);
  if (parsed < 1 || parsed > 10_000_000) throw new SourcePayloadError('value', `${what} is outside the plausible BTC price range`);
  return parsed;
}

function nonNegative(value: unknown, what: string, max: number): number {
  const parsed = number(value, what);
  if (parsed < 0 || parsed > max) throw new SourcePayloadError('value', `${what} is outside the plausible range`);
  return parsed;
}

function fundingRate(value: unknown, what: string, intervalHours: number): number {
  const normalized = normalizeToEightHours(number(value, what), intervalHours);
  if (normalized === null || Math.abs(normalized) > MAX_FUNDING_RATE_8H) {
    throw new SourcePayloadError('value', `${what} is not a plausible funding rate`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Bounded, allowlisted JSON GET. Redirects are refused, the body is read with a
// hard byte cap, and a non-JSON or non-2xx response is an isolated source error.
// `credentialHeaders` may only carry a header that the requested host's own
// source registered, and only in the header — never in the URL.
export async function fetchJsonFromAllowlist(
  url: string, fetchImpl: typeof fetch = fetch, credentialHeaders: Record<string, string> = {},
): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new SourcePayloadError('url', 'source URLs must be plain HTTPS without credentials or an explicit port');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new SourcePayloadError('host_not_allowed', `${parsed.hostname} is not an allowlisted source host`);
  const sourceId = Object.keys(SOURCE_HOSTS).find(id => SOURCE_HOSTS[id] === parsed.hostname)!;
  if (!isSourceEnabled(sourceId)) throw new SourcePayloadError('source_disabled', 'source collection is disabled pending permission');
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'CFLab-BitcoinSignals/1.0' };
  const permitted = AUTH_HEADERS_BY_HOST[parsed.hostname] ?? [];
  for (const [name, value] of Object.entries(credentialHeaders)) {
    if (!permitted.includes(name.toLowerCase())) {
      throw new SourcePayloadError('header_not_allowed', `a credential header is not permitted for ${parsed.hostname}`);
    }
    // A blank or multi-line value is refused rather than normalised.
    if (value.trim() === '' || /[\r\n]/.test(value)) throw new SourcePayloadError('header_not_allowed', 'a credential header value is invalid');
    headers[name.toLowerCase()] = value;
  }
  let response: Response;
  try {
    // Workers rejects redirect: 'error' (only 'follow' and 'manual' exist), so a
    // redirect is refused by inspecting the status below instead.
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (error) {
    // Structured, PII-free diagnostic: the transport cause, never the URL or body.
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    console.error(JSON.stringify({ event: 'signals_source_fetch_failed', ...(typeof cause === 'string' ? { cause } : {}) }));
    throw new SourcePayloadError('network', 'the source could not be reached');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SourcePayloadError('redirect', 'the source redirected instead of answering directly');
  }
  if (!response.ok) throw new SourcePayloadError(`http_${response.status}`, `the source answered HTTP ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    throw new SourcePayloadError('content_type', 'the source did not return JSON');
  }
  if (!response.body) throw new SourcePayloadError('shape', 'the source returned an empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SourcePayloadError('too_large', 'the source response exceeded the byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SourcePayloadError('shape', 'the source response was not valid UTF-8 JSON');
  }
}

const OKX_FUNDING = 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP';
const OKX_FUNDING_HISTORY = 'https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100';
const OKX_SPOT = 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT';
const OKX_INDEX = 'https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USDT';
const DERIBIT_PERP = 'https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL';
const DERIBIT_INSTRUMENTS = 'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=future&expired=false';
const DERIBIT_BOOK = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future';
const KRAKEN_FUTURES_TICKERS = 'https://futures.kraken.com/derivatives/api/v3/tickers';
const KRAKEN_SPOT_TICKER = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
const COINBASE_TICKER = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const MEMPOOL_LIGHTNING = 'https://mempool.space/api/v1/lightning/statistics/latest';
const COINGECKO_TREASURY = 'https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin';

const COMPANY_LIMIT = 50;

function okxRow(payload: unknown, what: string): Record<string, unknown> {
  const root = object(payload, what);
  if (root.code !== '0') throw new SourcePayloadError('api_error', `${what} reported code ${String(root.code)}`);
  const row = array(root.data, `${what}.data`)[0];
  if (!isRecord(row)) throw new SourcePayloadError('shape', `${what} returned no rows`);
  return row;
}

function deribitResult(payload: unknown, what: string): unknown {
  const root = object(payload, what);
  if (root.error) throw new SourcePayloadError('api_error', `${what} returned an error`);
  return root.result;
}

// OKX publishes a funding rate per settlement period and a settled history with
// realized rates. Both are normalized to the 8-hour unit; the interval is read
// from the source rather than assumed.
const okx: Collector = {
  id: 'okx',
  cadence: 'hourly',
  url: OKX_FUNDING,
  async collect(fetchJson, now) {
    const out: RawObservation[] = [];
    const funding = okxRow(await fetchJson(OKX_FUNDING), 'OKX funding');
    const fundingTime = timestampMs(funding.fundingTime, 'OKX fundingTime');
    const nextFundingTime = timestampMs(funding.nextFundingTime, 'OKX nextFundingTime');
    const intervalHours = (nextFundingTime - fundingTime) / 3_600_000;
    if (!isFundingIntervalHours(intervalHours)) throw new SourcePayloadError('value', 'OKX funding interval is not a supported interval');
    // The quote is observed when the venue published it (`ts`), not at the
    // settlement time it refers to, which may still be in the future.
    out.push({
      series: 'funding_current_8h', venue: 'okx', observedAt: isoFromMs(funding.ts, 'OKX funding ts'),
      value: fundingRate(funding.fundingRate, 'OKX fundingRate', intervalHours),
      meta: {
        interval_hours: intervalHours, raw_rate: number(funding.fundingRate, 'OKX fundingRate'),
        funding_at: new Date(fundingTime).toISOString(), next_funding_at: new Date(nextFundingTime).toISOString(),
      },
    });

    const historyRoot = object(await fetchJson(OKX_FUNDING_HISTORY), 'OKX funding history');
    if (historyRoot.code !== '0') throw new SourcePayloadError('api_error', 'OKX funding history reported an error');
    const history = array(historyRoot.data, 'OKX funding history data')
      .filter(isRecord)
      .map(row => ({
        at: timestampMs(row.fundingTime, 'OKX history fundingTime'),
        rate: number(row.realizedRate ?? row.fundingRate, 'OKX history rate'),
      }))
      .filter(row => Number.isFinite(row.rate))
      // A settled series must not contain a period that has not settled yet.
      .filter(row => row.at <= now.getTime() + 60_000)
      .slice(0, 100);
    history.sort((a, b) => a.at - b.at);
    for (let i = 1; i < history.length; i += 1) {
      const row = history[i]!;
      // Each settlement pays for the interval since the previous settlement.
      // Never apply a modal/current interval across a historical interval change.
      const historyInterval = inferFundingIntervalHours([history[i - 1]!.at, row.at]);
      if (historyInterval === null) continue;
      out.push({
        series: 'funding_settled_8h', venue: 'okx', observedAt: new Date(row.at).toISOString(), url: OKX_FUNDING_HISTORY,
        value: fundingRate(row.rate, 'OKX settled funding rate', historyInterval),
        meta: { interval_hours: historyInterval, raw_rate: row.rate },
      });
    }

    const spot = okxRow(await fetchJson(OKX_SPOT), 'OKX spot ticker');
    out.push({ series: 'spot_price_usd', venue: 'okx', observedAt: isoFromMs(spot.ts, 'OKX spot ts'), value: price(spot.last, 'OKX spot last'), url: OKX_SPOT, meta: {} });

    const index = okxRow(await fetchJson(OKX_INDEX), 'OKX index ticker');
    out.push({ series: 'index_price_usd', venue: 'okx', observedAt: isoFromMs(index.ts, 'OKX index ts'), value: price(index.idxPx, 'OKX index idxPx'), url: OKX_INDEX, meta: {} });
    return out;
  },
};

// Deribit publishes the perpetual funding rate already expressed per 8 hours, so
// no interval normalization is needed. One dated contract (the nearest live
// expiry) provides the cash-and-carry basis input.
const deribit: Collector = {
  id: 'deribit',
  cadence: 'hourly',
  url: DERIBIT_PERP,
  async collect(fetchJson, collectedAt) {
    const out: RawObservation[] = [];
    const ticker = object(deribitResult(await fetchJson(DERIBIT_PERP), 'Deribit ticker'), 'Deribit ticker result');
    const observedAt = isoFromMs(ticker.timestamp, 'Deribit timestamp');
    out.push({
      series: 'funding_current_8h', venue: 'deribit', observedAt,
      value: fundingRate(ticker.funding_8h, 'Deribit funding_8h', 8),
      meta: { interval_hours: 8, raw_rate: number(ticker.funding_8h, 'Deribit funding_8h') },
    });
    out.push({ series: 'index_price_usd', venue: 'deribit', observedAt, value: price(ticker.index_price, 'Deribit index_price'), meta: {} });
    out.push({ series: 'perp_mark_price_usd', venue: 'deribit', observedAt, value: price(ticker.mark_price, 'Deribit mark_price'), meta: {} });

    const now = collectedAt.getTime();
    const instruments = array(deribitResult(await fetchJson(DERIBIT_INSTRUMENTS), 'Deribit instruments'), 'Deribit instruments')
      .filter(isRecord)
      .filter(row => /^BTC-\d{1,2}[A-Z]{3}\d{2}$/.test(String(row.instrument_name)) && row.is_active !== false)
      .map(row => ({ name: String(row.instrument_name), expiry: number(row.expiration_timestamp, 'Deribit expiration_timestamp') }))
      .filter(row => row.expiry - now > 12 * 3_600_000)
      .sort((a, b) => a.expiry - b.expiry);
    const nearest = instruments[0];
    if (!nearest) return out;
    const book = array(deribitResult(await fetchJson(DERIBIT_BOOK), 'Deribit book summary'), 'Deribit book summary')
      .filter(isRecord)
      .find(row => row.instrument_name === nearest.name);
    if (!book) throw new SourcePayloadError('shape', 'Deribit did not return a mark for the nearest dated future');
    out.push({
      series: 'dated_future_mark_usd', venue: `deribit:${nearest.name}`, observedAt: isoFromMs(book.creation_timestamp, 'Deribit future creation_timestamp'), url: DERIBIT_BOOK,
      value: price(book.mark_price, 'Deribit future mark_price'),
      meta: { family: 'deribit', instrument: nearest.name, expiry: new Date(nearest.expiry).toISOString(), index_usd: price(ticker.index_price, 'Deribit index_price') },
    });
    return out;
  },
};

function krakenSuccess(payload: unknown, what: string): Record<string, unknown> {
  const root = object(payload, what);
  if (root.result !== 'success') throw new SourcePayloadError('api_error', `${what} did not report success`);
  return root;
}

function utcFromKrakenSymbol(symbol: string): number | null {
  const match = /^FF_XBTUSD_(\d{2})(\d{2})(\d{2})$/.exec(symbol);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Kraken's dated contracts expire at 16:00 UTC on the listed date.
  const ms = Date.UTC(year, month - 1, day, 16, 0, 0);
  return Number.isFinite(ms) ? ms : null;
}

// Kraken Futures reports both an absolute funding rate and the relative rate used
// for carry; the published relative rate is per HOUR. The multiplier n=8 in
// Kraken's premium formula does not make the published rate an eight-hour rate.
const krakenFutures: Collector = {
  id: 'kraken-futures',
  cadence: 'hourly',
  url: KRAKEN_FUTURES_TICKERS,
  async collect(fetchJson, collectedAt) {
    const out: RawObservation[] = [];
    const root = krakenSuccess(await fetchJson(KRAKEN_FUTURES_TICKERS), 'Kraken Futures tickers');
    const serverTime = root.serverTime;
    if (typeof serverTime !== 'string' || !Number.isFinite(Date.parse(serverTime))) {
      throw new SourcePayloadError('shape', 'Kraken Futures serverTime is not a timestamp');
    }
    const observedAt = new Date(Date.parse(serverTime)).toISOString();
    const tickers = array(root.tickers, 'Kraken Futures tickers').filter(isRecord);
    const perpetual = tickers.find(row => row.symbol === 'PF_XBTUSD');
    if (!perpetual) throw new SourcePayloadError('shape', 'Kraken Futures did not return PF_XBTUSD');
    out.push({
      series: 'funding_current_8h', venue: 'kraken-futures', observedAt,
      value: fundingRate(perpetual.relativeFundingRate, 'Kraken relativeFundingRate', 1),
      meta: {
        interval_hours: 1, raw_rate: number(perpetual.relativeFundingRate, 'Kraken relativeFundingRate'),
        absolute_funding_rate: number(perpetual.fundingRate, 'Kraken fundingRate'),
      },
    });
    out.push({ series: 'index_price_usd', venue: 'kraken-futures', observedAt, value: price(perpetual.indexPrice, 'Kraken indexPrice'), meta: {} });
    out.push({ series: 'perp_mark_price_usd', venue: 'kraken-futures', observedAt, value: price(perpetual.markPrice, 'Kraken markPrice'), meta: {} });

    const now = collectedAt.getTime();
    const dated = tickers
      .map(row => ({ symbol: String(row.symbol ?? ''), expiry: utcFromKrakenSymbol(String(row.symbol ?? '')) }))
      .filter((row): row is { symbol: string; expiry: number } => row.expiry !== null && row.expiry - now > 12 * 3_600_000)
      .sort((a, b) => a.expiry - b.expiry)[0];
    if (!dated) return out;
    const future = tickers.find(row => row.symbol === dated.symbol);
    if (!future) return out;
    out.push({
      series: 'dated_future_mark_usd', venue: `kraken-futures:${dated.symbol}`, observedAt,
      value: price(future.markPrice, 'Kraken future markPrice'),
      meta: { family: 'kraken-futures', instrument: dated.symbol, expiry: new Date(dated.expiry).toISOString(), index_usd: price(future.indexPrice, 'Kraken future indexPrice') },
    });
    return out;
  },
};

const krakenSpot: Collector = {
  id: 'kraken-spot',
  cadence: 'hourly',
  url: KRAKEN_SPOT_TICKER,
  async collect(fetchJson, now) {
    const root = object(await fetchJson(KRAKEN_SPOT_TICKER), 'Kraken spot ticker');
    const errors = array(root.error, 'Kraken spot error');
    if (errors.length) throw new SourcePayloadError('api_error', 'Kraken spot reported an error');
    const result = object(root.result, 'Kraken spot result');
    const pair = result.XXBTZUSD;
    if (!isRecord(pair)) throw new SourcePayloadError('shape', 'Kraken spot did not return XXBTZUSD');
    const last = array(pair.c, 'Kraken spot last trade')[0];
    // Kraken omits a trade timestamp here, so the observation is recorded at
    // retrieval time and labelled as such in its provenance metadata.
    return [{ series: 'spot_price_usd', venue: 'kraken', observedAt: now.toISOString(), value: price(last, 'Kraken spot last'), meta: { observed_at_source: 'retrieval' } }];
  },
};

const coinbaseSpot: Collector = {
  id: 'coinbase-spot',
  cadence: 'hourly',
  url: COINBASE_TICKER,
  async collect(fetchJson) {
    const root = object(await fetchJson(COINBASE_TICKER), 'Coinbase ticker');
    const time = root.time;
    if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw new SourcePayloadError('shape', 'Coinbase time is not a timestamp');
    return [{ series: 'spot_price_usd', venue: 'coinbase', observedAt: new Date(Date.parse(time)).toISOString(), value: price(root.price, 'Coinbase price'), meta: {} }];
  },
};

// mempool.space publishes an aggregated Lightning snapshot. Its `added` field is
// not a reliable measurement time (the live API has served non-monotonic values,
// including months-old dates, for newer dataset ids), so the observation time is
// the collection time and the dataset's own id and added date travel as
// provenance instead. That keeps the series honest: it records what was published
// when CFLab looked, not a timestamp invented from an unreliable field.
const mempoolLightning: Collector = {
  id: 'mempool-space',
  cadence: 'hourly',
  url: MEMPOOL_LIGHTNING,
  async collect(fetchJson, now) {
    const root = object(await fetchJson(MEMPOOL_LIGHTNING), 'mempool.space lightning statistics');
    const latest = object(root.latest, 'mempool.space latest');
    const addedRaw = latest.added;
    const added = typeof addedRaw === 'string' && Number.isFinite(Date.parse(addedRaw)) ? new Date(Date.parse(addedRaw)).toISOString() : null;
    const observedAt = now.toISOString();
    const meta = { dataset_id: number(latest.id, 'mempool.space id'), dataset_added: added, observed_at_source: 'retrieval' };
    return [
      { series: 'lightning_node_count', venue: 'public-network', observedAt, value: nonNegative(latest.node_count, 'mempool.space node_count', 10_000_000), meta },
      { series: 'lightning_channel_count', venue: 'public-network', observedAt, value: nonNegative(latest.channel_count, 'mempool.space channel_count', 100_000_000), meta },
      { series: 'lightning_capacity_btc', venue: 'public-network', observedAt, value: nonNegative(latest.total_capacity, 'mempool.space total_capacity', 100_000_000_000_000) / 100_000_000, meta },
    ];
  },
};

// CoinGecko aggregates public-company disclosures. The API has no as-of
// timestamp, so the observation time is the retrieval time and the provenance
// records exactly that. Values are reported figures, never audited by CFLab.
// The Demo API documents this endpoint at
// https://docs.coingecko.com/demo/reference/companies-public-treasury and requires
// the `x-cg-demo-api-key` header that `sourceRequestHeaders` supplies; the key is
// never part of the URL, the stored evidence URL, or a stored value.
const coingeckoTreasury: Collector = {
  id: 'coingecko-treasury',
  cadence: 'daily',
  url: COINGECKO_TREASURY,
  async collect(fetchJson, now) {
    const root = object(await fetchJson(COINGECKO_TREASURY), 'CoinGecko treasury dataset');
    const observedAt = now.toISOString();
    const meta = { observed_at_source: 'retrieval', attribution: 'CoinGecko' };
    const out: RawObservation[] = [
      { series: 'treasury_total_btc', venue: 'public-companies', observedAt, value: nonNegative(root.total_holdings, 'CoinGecko total_holdings', 21_000_000), meta },
      { series: 'treasury_total_usd', venue: 'public-companies', observedAt, value: nonNegative(root.total_value_usd, 'CoinGecko total_value_usd', 100_000_000_000_000), meta },
      { series: 'treasury_market_cap_dominance_pct', venue: 'public-companies', observedAt, value: nonNegative(root.market_cap_dominance, 'CoinGecko market_cap_dominance', 100), meta },
    ];
    for (const company of array(root.companies, 'CoinGecko companies').filter(isRecord).slice(0, COMPANY_LIMIT)) {
      const symbol = typeof company.symbol === 'string' && company.symbol.trim() ? company.symbol.trim().slice(0, 32) : null;
      if (!symbol) continue;
      out.push({
        series: 'treasury_company_btc', venue: symbol, observedAt,
        value: nonNegative(company.total_holdings, `CoinGecko ${symbol} total_holdings`, 21_000_000),
        meta: {
          name: typeof company.name === 'string' ? company.name.slice(0, 120) : symbol,
          country: typeof company.country === 'string' ? company.country.slice(0, 8) : null,
          entry_value_usd: number(company.total_entry_value_usd ?? 0, `CoinGecko ${symbol} total_entry_value_usd`),
          current_value_usd: number(company.total_current_value_usd ?? 0, `CoinGecko ${symbol} total_current_value_usd`),
          supply_pct: number(company.percentage_of_total_supply ?? 0, `CoinGecko ${symbol} percentage_of_total_supply`),
        },
      });
    }
    return out;
  },
};

// Order is stable so a collection run reports sources in a predictable order.
export const COLLECTORS: readonly Collector[] = [okx, deribit, krakenFutures, krakenSpot, coinbaseSpot, mempoolLightning, coingeckoTreasury];

export function collectorsFor(cadence: 'hourly' | 'daily'): Collector[] {
  return COLLECTORS.filter(collector => collector.cadence === cadence && isSourceEnabled(collector.id));
}
