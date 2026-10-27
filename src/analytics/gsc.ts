import { Hono } from 'hono';
import { ApiError } from '../http';
import { authenticate } from './auth';
import type { AnalyticsEnv } from './env';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function googleServiceToken(json: string, fetcher: typeof fetch = fetch): Promise<string> {
  let account: ServiceAccount;
  try {
    account = JSON.parse(json) as ServiceAccount;
  } catch {
    throw new Error('invalid_service_account');
  }
  if (!account || typeof account.client_email !== 'string' ||
      !account.client_email.endsWith('.iam.gserviceaccount.com') ||
      typeof account.private_key !== 'string' ||
      !account.private_key.includes('BEGIN PRIVATE KEY') ||
      (account.token_uri && account.token_uri !== TOKEN_URL)) {
    throw new Error('invalid_service_account');
  }

  const der = Uint8Array.from(
    atob(account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
    c => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const assertionBody = encodeJson({
    iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  });
  const unsigned = encodeJson({ alg: 'RS256', typ: 'JWT' }) + '.' + assertionBody;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + base64url(new Uint8Array(signature));

  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('google_token_rejected');
  const body = await res.json() as { access_token?: unknown };
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('google_token_invalid');
  return body.access_token;
}

export async function discoverSearchConsoleProperties(json: string, fetcher: typeof fetch = fetch) {
  const token = await googleServiceToken(json, fetcher);
  const res = await fetcher(SITES_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('google_sites_rejected');
  const body = await res.json() as { siteEntry?: Array<{ siteUrl?: unknown; permissionLevel?: unknown }> };
  if (body.siteEntry !== undefined && !Array.isArray(body.siteEntry)) throw new Error('google_sites_invalid');
  return (body.siteEntry ?? []).filter(site =>
    typeof site.siteUrl === 'string' && typeof site.permissionLevel === 'string',
  ).map(site => ({ siteUrl: site.siteUrl as string, permissionLevel: site.permissionLevel as string }));
}

export const gsc = new Hono<AnalyticsEnv>();
gsc.get('/properties', async c => {
  const identity = await authenticate(c.env, c.req.header('Authorization'));
  if (!identity.isAdmin) throw new ApiError(403, 'forbidden', 'Administrator access required');
  const json = c.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!json) return c.json({ status: 'not_configured' }, 503);
  try {
    const properties = await discoverSearchConsoleProperties(json);
    return c.json({ status: 'ok', count: properties.length, properties });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown';
    // Never log Google responses, OAuth assertions, tokens or the service-account JSON.
    console.error(JSON.stringify({ event: 'gsc_discovery_failed', code: /^[a-z_]+$/.test(code) ? code : 'unexpected' }));
    return c.json({ status: 'error', code: 'gsc_connection_failed' }, 502);
  }
});
