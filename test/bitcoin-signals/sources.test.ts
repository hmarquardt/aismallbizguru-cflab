import { describe, expect, it, vi } from 'vitest';
import { COLLECTORS, MAX_RESPONSE_BYTES, SourcePayloadError, fetchJsonFromAllowlist, sourceRequestHeaders } from '../../src/bitcoin-signals/sources';

describe('bounded public-source transport', () => {
  it('rejects untrusted hosts, credentials, ports and protocols before fetching', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['https://www.okx.com.evil.test/a', 'https://evil.test/', 'https://secret@www.okx.com/a', 'https://www.okx.com:444/a', 'http://www.okx.com/a']) {
      await expect(fetchJsonFromAllowlist(url, fetchImpl as typeof fetch)).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses redirects, rate limits, non-JSON and malformed JSON', async () => {
    for (const [response, code] of [
      [new Response('', { status: 302, headers: { location: 'https://evil.test' } }), 'redirect'],
      [new Response('', { status: 429 }), 'http_429'],
      [new Response('<html>blocked</html>'), 'content_type'],
      [new Response('{bad}', { headers: { 'content-type': 'application/json' } }), 'shape'],
    ] as const) {
      await expect(fetchJsonFromAllowlist('https://api.exchange.coinbase.com/a', (async (_url, init) => {
        expect(init?.redirect).toBe('manual');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.headers).not.toHaveProperty('Authorization');
        return response;
      }) as typeof fetch)).rejects.toMatchObject({ code });
    }
  });

  it('cancels a stream as soon as its byte budget is exceeded', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    await expect(fetchJsonFromAllowlist('https://api.exchange.coinbase.com/a', (async () => new Response(stream, { headers: { 'content-type': 'application/json' } })) as typeof fetch))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(cancelled).toBe(true);
  });
});

describe('CoinGecko Demo API credential', () => {
  const key = 'demo-key-held-in-the-worker-secret';
  const treasuryUrl = 'https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin';

  function capture() {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('sends the configured key as the x-cg-demo-api-key header and never in the URL', async () => {
    const { calls, fetchImpl } = capture();
    const headers = sourceRequestHeaders('coingecko-treasury', { COINGECKO_DEMO_API_KEY: key });
    expect(headers).toEqual({ 'x-cg-demo-api-key': key });
    await fetchJsonFromAllowlist(treasuryUrl, fetchImpl, headers);
    expect(calls[0]!.headers).toMatchObject({ accept: 'application/json', 'x-cg-demo-api-key': key });
    expect(calls[0]!.url).toBe(treasuryUrl);
    expect(calls[0]!.url).not.toContain(key);
    expect(JSON.stringify(calls.map(call => call.url))).not.toContain(key);
  });

  it('gives every other source no credential and refuses the header on another host', async () => {
    expect(sourceRequestHeaders('coinbase-spot', { COINGECKO_DEMO_API_KEY: key })).toEqual({});
    expect(sourceRequestHeaders('curated-research', { COINGECKO_DEMO_API_KEY: key })).toEqual({});
    const { calls, fetchImpl } = capture();
    await expect(fetchJsonFromAllowlist('https://api.exchange.coinbase.com/products/BTC-USD/ticker', fetchImpl,
      sourceRequestHeaders('coingecko-treasury', { COINGECKO_DEMO_API_KEY: key })))
      .rejects.toMatchObject({ code: 'header_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a blank or multi-line credential value before any request', async () => {
    const { calls, fetchImpl } = capture();
    for (const value of ['', '   ', ['abc', 'define'].join(String.fromCharCode(10))]) {
      await expect(fetchJsonFromAllowlist(treasuryUrl, fetchImpl, { 'x-cg-demo-api-key': value }))
        .rejects.toMatchObject({ code: 'header_not_allowed' });
    }
    expect(calls).toHaveLength(0);
  });

  it('reports missing configuration as its own stable source error', () => {
    for (const value of [undefined, '', '   ']) {
      let caught: unknown;
      try {
        sourceRequestHeaders('coingecko-treasury', { COINGECKO_DEMO_API_KEY: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SourcePayloadError);
      expect(caught).toMatchObject({ code: 'missing_credential' });
      // The diagnostic never echoes the configured value or a key-shaped string.
      expect((caught as Error).message).toBe('the source requires a configured API key');
    }
  });
});

describe('OKX settlement interval provenance', () => {
  it('normalizes each historical interval independently and omits an unknown first period', async () => {
    const now = new Date('2026-10-25T16:00:00.000Z');
    const hour = 3_600_000;
    const rows = await COLLECTORS[0]!.collect(async url => {
      if (url.includes('funding-rate-history')) return { code: '0', data: [0, 4, 8, 16].map(h => ({ fundingTime: now.getTime() - 24 * hour + h * hour, realizedRate: '0.0001' })) };
      if (url.includes('funding-rate?')) return { code: '0', data: [{ ts: now.getTime(), fundingTime: now.getTime(), nextFundingTime: now.getTime() + 8 * hour, fundingRate: '0.0001' }] };
      return { code: '0', data: [{ ts: now.getTime(), last: '80000', idxPx: '80000' }] };
    }, now);
    const settled = rows.filter(row => row.series === 'funding_settled_8h');
    expect(settled.map(row => row.value)).toEqual([0.0002, 0.0002, 0.0001]);
    expect(settled.map(row => row.meta?.interval_hours)).toEqual([4, 4, 8]);
  });
});
