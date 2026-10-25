import { describe, expect, it, vi } from 'vitest';
import { COLLECTORS, MAX_RESPONSE_BYTES, fetchJsonFromAllowlist } from '../../src/bitcoin-signals/sources';

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
