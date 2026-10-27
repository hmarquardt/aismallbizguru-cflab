import { beforeAll, describe, expect, it } from 'vitest';
import {
  GscClient, GscError, MAX_ATTEMPTS, ROW_LIMIT, SEARCH_ANALYTICS_URL, TOKEN_SCOPE, TOKEN_URL,
  discoverSearchConsoleProperties, googleServiceToken, parseSearchAnalyticsRow,
} from '../../src/analytics/gsc-client';

// A keypair generated for this test only. Nothing is committed, so no credential
// material enters the repository, and the signature is verified for real.
interface KeyPair { json: string; publicKey: CryptoKey }

async function testServiceAccount(email = 'cflab-test@project.iam.gserviceaccount.com'): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`;
  return {
    json: JSON.stringify({ client_email: email, private_key: pem, token_uri: TOKEN_URL }),
    publicKey: pair.publicKey,
  };
}

interface Call { url: string; init: RequestInit }

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return await handler(call);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tokenResponse(): Response {
  return json({ access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer' });
}

function decode(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as Record<string, unknown>;
}

let account: KeyPair;
beforeAll(async () => { account = await testServiceAccount(); });

describe('service-account authentication', () => {
  it('signs a verifiable RS256 assertion with the read-only scope', async () => {
    let assertion = '';
    const { fetcher } = mockFetch(call => {
      expect(call.url).toBe(TOKEN_URL);
      const params = new URLSearchParams(String(call.init.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertion = params.get('assertion') ?? '';
      return tokenResponse();
    });
    await expect(googleServiceToken(account.json, fetcher)).resolves.toBe('ya29.test-access-token');

    const [header, payload, signature] = assertion.split('.');
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload!);
    expect(claims.iss).toBe('cflab-test@project.iam.gserviceaccount.com');
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.scope).toBe(TOKEN_SCOPE);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);

    const bytes = Uint8Array.from(atob(signature!.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', account.publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it('rejects malformed or unexpected service-account material without echoing it', async () => {
    const { fetcher, calls } = mockFetch(() => tokenResponse());
    for (const json of ['not-json', JSON.stringify({ client_email: 'user@example.com', private_key: 'x' }),
      JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----oops' })]) {
      await expect(googleServiceToken(json, fetcher)).rejects.toMatchObject({ code: 'invalid_service_account' });
    }
    expect(calls).toHaveLength(0);
  });

  it('distinguishes a rejected token exchange from a network failure', async () => {
    const rejected = mockFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(googleServiceToken(account.json, rejected.fetcher)).rejects.toMatchObject({ code: 'google_token_rejected' });
    expect(rejected.calls).toHaveLength(1);

    const offline = mockFetch(() => { throw new TypeError('network down'); });
    const error = await googleServiceToken(account.json, offline.fetcher).catch(value => value);
    expect(error).toBeInstanceOf(GscError);
    expect(error.code).toBe('network_error');
    expect(offline.calls).toHaveLength(MAX_ATTEMPTS);
    expect(String(error.message)).not.toContain('ya29');
  });
});

describe('property discovery', () => {
  it('returns the accessible properties and drops malformed entries', async () => {
    const { fetcher, calls } = mockFetch(call => {
      if (call.url === TOKEN_URL) return tokenResponse();
      expect(call.url).toBe('https://www.googleapis.com/webmasters/v3/sites');
      expect(new Headers(call.init.headers).get('Authorization')).toBe('Bearer ya29.test-access-token');
      return json({
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
          { siteUrl: 'sc-domain:second.example', permissionLevel: 'siteOwner' },
          { siteUrl: 42, permissionLevel: 'siteOwner' },
          { permissionLevel: 'siteOwner' },
          null,
        ],
      });
    });
    const properties = await discoverSearchConsoleProperties(account.json, fetcher);
    expect(properties).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
      { siteUrl: 'sc-domain:second.example', permissionLevel: 'siteOwner' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('reports an inaccessible account distinctly and never retries it', async () => {
    const { fetcher, calls } = mockFetch(call =>
      call.url === TOKEN_URL ? tokenResponse() : json({ error: { code: 403 } }, 403));
    await expect(discoverSearchConsoleProperties(account.json, fetcher))
      .rejects.toMatchObject({ code: 'google_sites_rejected' });
    expect(calls).toHaveLength(2);
  });

  it('rejects a discovery body that is not a site list', async () => {
    const { fetcher } = mockFetch(call =>
      call.url === TOKEN_URL ? tokenResponse() : json({ siteEntry: 'nope' }));
    await expect(discoverSearchConsoleProperties(account.json, fetcher))
      .rejects.toMatchObject({ code: 'google_sites_invalid' });
  });
});

describe('search analytics queries', () => {
  function clientWith(handler: (call: Call) => Response | Promise<Response>) {
    const mock = mockFetch(call => (call.url === TOKEN_URL ? tokenResponse() : handler(call)));
    return { client: new GscClient(account.json, mock.fetcher), calls: mock.calls };
  }

  function queryBody(call: Call): Record<string, unknown> {
    return JSON.parse(String(call.init.body)) as Record<string, unknown>;
  }

  it('sends the documented dimensions, limits and date range', async () => {
    const { client, calls } = clientWith(() => json({ rows: [] }));
    await client.query('sc-domain:example.com', {
      startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['date', 'query'], dataState: 'all',
    });
    const queryCall = calls[1]!;
    expect(queryCall.url).toBe(`${SEARCH_ANALYTICS_URL}/sc-domain%3Aexample.com/searchAnalytics/query`);
    expect(queryBody(queryCall)).toEqual({
      startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['date', 'query'],
      dataState: 'all', rowLimit: ROW_LIMIT, startRow: 0, type: 'web',
    });
  });

  it('reads rows, rejects malformed rows, and keeps Google freshness metadata', async () => {
    const { client } = clientWith(() => json({
      rows: [
        { keys: ['2026-10-05'], clicks: 4, impressions: 120, ctr: 0.033, position: 7.25 },
        { keys: ['2026-10-05'], clicks: -1, impressions: 10, ctr: 0.1, position: 2 },
        { keys: ['2026-10-05'], clicks: 1, impressions: 10, ctr: 3, position: 2 },
        { keys: 'not-an-array', clicks: 1, impressions: 1, ctr: 1, position: 1 },
        null,
      ],
      metadata: { first_incomplete_date: '2026-10-05' },
    }));
    const result = await client.query('sc-domain:example.com', {
      startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['date'],
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ keys: ['2026-10-05'], clicks: 4, impressions: 120, ctr: 0.033, position: 7.25 });
    // A CTR outside 0..1 is recomputed from the counts rather than trusted.
    expect(result.rows[1]!.ctr).toBeCloseTo(0.1);
    expect(result.rejected_rows).toBe(3);
    expect(result.first_incomplete_date).toBe('2026-10-05');
  });

  it('maps API failures to distinct, non-retryable codes', async () => {
    for (const [status, code] of [[403, 'access_denied'], [400, 'invalid_request'], [404, 'property_not_accessible']] as const) {
      const { client, calls } = clientWith(() => json({ error: { code: status } }, status));
      await expect(client.query('sc-domain:example.com', {
        startDate: '2026-10-01', endDate: '2026-10-02', dimensions: ['date'],
      })).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(2);
    }
  });
});

describe('bounded pagination and retries', () => {
  function clientWith(handler: (call: Call) => Response | Promise<Response>) {
    const mock = mockFetch(call => (call.url === TOKEN_URL ? tokenResponse() : handler(call)));
    return { client: new GscClient(account.json, mock.fetcher), calls: mock.calls };
  }

  function rows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      keys: [`2026-10-05`, `query-${index}`], clicks: 1, impressions: 2, ctr: 0.5, position: 3,
    }));
  }

  const body = { startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['date', 'query'] };

  it('follows a full page and stops on the first short page', async () => {
    const { client, calls } = clientWith(call => {
      const startRow = JSON.parse(String(call.init.body)).startRow as number;
      return json({ rows: startRow === 0 ? rows(ROW_LIMIT) : rows(5) });
    });
    const result = await client.query('sc-domain:example.com', body);
    expect(result.requests).toBe(2);
    expect(result.rows).toHaveLength(ROW_LIMIT + 5);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('stops at the page cap and reports truncation instead of completeness', async () => {
    const { client, calls } = clientWith(() => json({ rows: rows(ROW_LIMIT) }));
    const result = await client.query('sc-domain:example.com', body);
    expect(result.requests).toBe(3);
    expect(result.rows).toHaveLength(ROW_LIMIT * 3);
    expect(result.truncated).toBe(true);
    const offsets = calls.slice(1).map(call => JSON.parse(String(call.init.body)).startRow);
    expect(offsets).toEqual([0, ROW_LIMIT, ROW_LIMIT * 2]);
  });

  it('retries 429 and 5xx with the same request, then succeeds', async () => {
    let attempt = 0;
    const { client, calls } = clientWith(() => {
      attempt += 1;
      if (attempt === 1) return json({ error: { code: 429 } }, 429);
      if (attempt === 2) return json({ error: { code: 503 } }, 503);
      return json({ rows: [{ keys: ['2026-10-05'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] });
    });
    const result = await client.query('sc-domain:example.com', body);
    expect(result.rows).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('gives up after the attempt cap and reports the last failure', async () => {
    const { client, calls } = clientWith(() => json({ error: { code: 500 } }, 500));
    await expect(client.query('sc-domain:example.com', body)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(calls).toHaveLength(1 + MAX_ATTEMPTS);
  });

  it('never retries a timeout into an unbounded loop, and keeps the code distinct', async () => {
    const { client, calls } = clientWith(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(client.query('sc-domain:example.com', body)).rejects.toMatchObject({ code: 'request_timeout' });
    expect(calls).toHaveLength(1 + MAX_ATTEMPTS);
  });

  it('rejects a non-JSON body instead of treating it as an empty report', async () => {
    const { client } = clientWith(() => new Response('<html>nope</html>', { status: 200 }));
    await expect(client.query('sc-domain:example.com', body)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects rows where Google omits keys for the requested dimensions', async () => {
    const { client } = clientWith(() => json({ rows: [{ clicks: 1, impressions: 1, ctr: 1, position: 1 }] }));
    const result = await client.query('sc-domain:example.com', body);
    expect(result.rows).toHaveLength(0);
  });
});

describe('row validation', () => {
  it('accepts the documented shape', () => {
    expect(parseSearchAnalyticsRow({ keys: ['x'], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }))
      .toEqual({ keys: ['x'], clicks: 1, impressions: 2, ctr: 0.5, position: 1 });
    expect(parseSearchAnalyticsRow({ keys: ['2026-10-05'], clicks: 1, impressions: 0, ctr: 0, position: null }))
      .toMatchObject({ ctr: 0, position: null });
  });

  it('rejects rows that cannot be read honestly', () => {
    for (const row of [
      null, 'row', 42,
      { clicks: 1, impressions: 2 },
      { keys: [], clicks: 1, impressions: 2 },
      { keys: ['x'], clicks: 'one', impressions: 2 },
      { keys: ['x'], clicks: 1, impressions: Number.NaN },
      { keys: ['x'], clicks: -1, impressions: 2 },
      { keys: [1], clicks: 1, impressions: 2 },
      { keys: 'not-an-array', clicks: 1, impressions: 2 },
    ]) {
      expect(parseSearchAnalyticsRow(row)).toBeNull();
    }
  });

  it('recomputes an implausible ctr from the counts and drops a bad position', () => {
    expect(parseSearchAnalyticsRow({ keys: ['x'], clicks: 3, impressions: 12, ctr: 4, position: -1 }))
      .toMatchObject({ ctr: 0.25, position: null });
  });
});
