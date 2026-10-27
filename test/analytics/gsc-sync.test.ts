import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindings, migrate, resetData, seedHuman, testEnv } from './helpers';
import { GSC_PROPERTIES } from '../../src/analytics/gsc-properties';
import analyticsWorker from '../../src/analytics/index';

// The manual trigger is the only write-shaped Search Console endpoint. These
// tests cover its authorization, its bounds, and that it never returns
// credential material.
async function serviceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  return JSON.stringify({
    client_email: 'manual-sync@project.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

let credential = '';
beforeAll(async () => {
  await migrate();
  credential = await serviceAccountJson();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
  await bindings.ANALYTICS.batch([
    bindings.ANALYTICS.prepare('DELETE FROM gsc_properties'),
    bindings.ANALYTICS.prepare('DELETE FROM gsc_sync_state'),
    bindings.ANALYTICS.prepare("DELETE FROM console_job_runs WHERE job = 'analytics-search-console'"),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function syncRequest(token?: string, body?: unknown, environment = testEnv({ GSC_SERVICE_ACCOUNT_JSON: credential })) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return analyticsWorker.fetch(
    new Request('https://analytics.aismallbizguru.com/api/gsc/sync', {
      method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    environment,
    {} as ExecutionContext,
  );
}

function fakeGoogle(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'ya29.fake' }), { status: 200 });
    }
    if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
      return new Response(JSON.stringify({
        siteEntry: GSC_PROPERTIES.map(entry => ({ siteUrl: entry.property, permissionLevel: 'siteRestrictedUser' })),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ rows: [] }), { status: 200 });
  });
}

describe('manual Search Console synchronization', () => {
  it('rejects unauthenticated callers before touching configuration', async () => {
    const response = await syncRequest();
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('manual-sync@');
  });

  it('rejects authenticated non-administrators', async () => {
    const token = await seedHuman('member@example.com', false);
    expect((await syncRequest(token)).status).toBe(403);
  });

  it('reports an unconfigured secret without running anything', async () => {
    const token = await seedHuman('admin@example.com', true);
    const response = await syncRequest(token, undefined, testEnv({ GSC_SERVICE_ACCOUNT_JSON: undefined }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_configured' });
  });

  it('rejects an unknown scope without spending a run', async () => {
    const token = await seedHuman('admin@example.com', true);
    expect((await syncRequest(token, { scope: 'everything' })).status).toBe(400);
    expect((await syncRequest(token, { scope: 7 })).status).toBe(400);
  });

  it('refuses to start while another run holds the lease', async () => {
    const token = await seedHuman('admin@example.com', true);
    await bindings.ANALYTICS.prepare(
      `INSERT INTO gsc_sync_state (id, lease_owner, lease_expires_at_ms, updated_at_ms) VALUES (1, 'other', ?, ?)`)
      .bind(Date.now() + 5 * 60_000, Date.now()).run();
    const response = await syncRequest(token, { scope: 'daily' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'sync_in_progress' } });
  });

  it('runs, reports per-property outcomes, and never echoes credentials', async () => {
    fakeGoogle();
    const token = await seedHuman('admin@example.com', true);
    const response = await syncRequest(token, { scope: 'daily' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('manual-sync@');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).not.toContain('ya29');
    const body = JSON.parse(text) as { status: string; scope: string; properties: { property: string; status: string }[] };
    expect(body.status).toBe('ok');
    expect(body.scope).toBe('daily');
    expect(body.properties).toHaveLength(GSC_PROPERTIES.length);
    expect(body.properties.every(item => item.status === 'empty')).toBe(true);

    const run = await bindings.ANALYTICS.prepare(
      "SELECT status FROM console_job_runs WHERE job = 'analytics-search-console'").first<{ status: string }>();
    expect(run!.status).toBe('ok');
  });

  it('bounds manual runs to four per hour', async () => {
    fakeGoogle();
    const token = await seedHuman('admin@example.com', true);
    for (let index = 0; index < 4; index += 1) {
      expect((await syncRequest(token, { scope: 'daily' })).status).toBe(200);
    }
    const limited = await syncRequest(token, { scope: 'daily' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'sync_rate_limited' } });
  });
});
