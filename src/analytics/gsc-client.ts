// Server-to-server Google Search Console client.
//
// This module is the only place that touches Google credentials. It never logs,
// returns, or stores the service-account JSON, the signed JWT assertion, or an
// access token: errors carry a short machine code only, and the caller decides
// what to record.
//
// Everything is bounded: one token per client, at most MAX_ATTEMPTS attempts per
// request, retries only for timeouts, 429 and 5xx, and at most MAX_PAGES pages
// (ROW_LIMIT rows each) per report. A short page ends pagination; a full last
// page is reported as `truncated` instead of being presented as complete.

export type GscErrorCode =
  | 'invalid_service_account'
  | 'google_token_rejected'
  | 'google_token_invalid'
  | 'google_sites_rejected'
  | 'google_sites_invalid'
  | 'property_not_accessible'
  | 'access_denied'
  | 'rate_limited'
  | 'upstream_error'
  | 'invalid_request'
  | 'invalid_response'
  | 'network_error'
  | 'request_timeout';

// The message is the code: a stack trace or a Google response body can contain
// request material, so neither is ever propagated.
export class GscError extends Error {
  constructor(public code: GscErrorCode, public status?: number) {
    super(code);
    this.name = 'GscError';
  }
}

export function errorCode(error: unknown): GscErrorCode {
  return error instanceof GscError ? error.code : 'upstream_error';
}

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
export const SEARCH_ANALYTICS_URL = 'https://www.googleapis.com/webmasters/v3/sites';
export const TOKEN_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export const MAX_ATTEMPTS = 3;
export const REQUEST_TIMEOUT_MS = 15_000;
export const RETRY_BASE_DELAY_MS = 300;
export const MAX_RETRY_DELAY_MS = 2_000;
/** Google's documented default. Requested explicitly so pagination is deterministic. */
export const ROW_LIMIT = 1_000;
/** Bounded pagination: three pages at most, then the report is marked truncated. */
export const MAX_PAGES = 3;
export const MAX_ROWS_PER_REPORT = ROW_LIMIT * MAX_PAGES;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface SearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  /** The last page was full, so Google may hold more rows for this report. */
  truncated: boolean;
  /** Google's own marker for the first day still being collected/processed. */
  first_incomplete_date: string | null;
  requests: number;
  /** Rows that did not have the documented shape and were not stored. */
  rejected_rows: number;
}

export interface QueryBody {
  startDate: string;
  endDate: string;
  dimensions: string[];
  dataState?: 'all' | 'final';
  rowLimit?: number;
  startRow?: number;
  searchType?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * attempt);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GscError('invalid_response', response.status);
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new GscError('invalid_response', response.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GscError('invalid_response', response.status);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GscError('invalid_response', response.status);
  return body as Record<string, unknown>;
}

interface RequestOptions {
  attempts?: number;
  tokenFailure?: 'google_token_rejected' | 'access_denied' | 'google_sites_rejected';
  notFound?: GscErrorCode;
}


// One bounded request. 401/403/400/404 are never retried: they are configuration
// or access problems that an immediate retry cannot fix.
async function request(
  fetcher: typeof fetch, url: string, init: RequestInit, options: RequestOptions = {},
): Promise<Record<string, unknown>> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const notFound = options.notFound ?? 'property_not_accessible';
  let last: GscError = new GscError('network_error');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      last = new GscError(name === 'TimeoutError' || name === 'AbortError' ? 'request_timeout' : 'network_error');
      if (attempt < attempts) { await sleep(retryDelay(attempt)); continue; }
      throw last;
    }
    if (response.status === 429) {
      last = new GscError('rate_limited', 429);
      if (attempt < attempts) { await sleep(retryDelay(attempt)); continue; }
      throw last;
    }
    if (response.status >= 500) {
      last = new GscError('upstream_error', response.status);
      if (attempt < attempts) { await sleep(retryDelay(attempt)); continue; }
      throw last;
    }
    if (response.status === 401 || response.status === 403) {
      // A rejected token exchange and a rejected API call are different
      // operational problems, so they stay distinguishable.
      throw new GscError(options.tokenFailure ?? 'access_denied', response.status);
    }
    if (response.status === 404) throw new GscError(notFound, 404);
    // A 4xx from the token endpoint is a rejected credential, not a malformed
    // query, so the token caller supplies its own code.
    if (response.status >= 400) throw new GscError(options.tokenFailure ?? 'invalid_request', response.status);
    if (!response.ok) throw new GscError('upstream_error', response.status);
    return await readJson(response);
  }
  throw last;
}


/** Exchanges the service account for an access token with the read-only scope. */
export async function googleServiceToken(json: string, fetcher: typeof fetch = fetch): Promise<string> {
  let account: ServiceAccount;
  try {
    account = JSON.parse(json) as ServiceAccount;
  } catch {
    throw new GscError('invalid_service_account');
  }
  if (!account || typeof account.client_email !== 'string' ||
      !account.client_email.endsWith('.iam.gserviceaccount.com') ||
      typeof account.private_key !== 'string' ||
      !account.private_key.includes('BEGIN PRIVATE KEY') ||
      (account.token_uri !== undefined && account.token_uri !== TOKEN_URL)) {
    throw new GscError('invalid_service_account');
  }

  let der: Uint8Array;
  try {
    der = Uint8Array.from(
      atob(account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
      c => c.charCodeAt(0),
    );
  } catch {
    throw new GscError('invalid_service_account');
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new GscError('invalid_service_account');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encodeJson({ alg: 'RS256', typ: 'JWT' }) + '.' + encodeJson({
    iss: account.client_email, scope: TOKEN_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + base64url(new Uint8Array(signature));

  const body = await request(fetcher, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  }, { tokenFailure: 'google_token_rejected' });
  if (typeof body.access_token !== 'string' || !body.access_token) throw new GscError('google_token_invalid');
  return body.access_token;
}

function sitesFromBody(body: Record<string, unknown>): GscSite[] {
  const entries = body.siteEntry;
  if (entries !== undefined && !Array.isArray(entries)) throw new GscError('google_sites_invalid');
  return (entries ?? []).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const site = entry as { siteUrl?: unknown; permissionLevel?: unknown };
    if (typeof site.siteUrl !== 'string' || typeof site.permissionLevel !== 'string') return [];
    return [{ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }];
  });
}

/** Lists properties the service account can see, with its permission on each. */
export async function discoverSearchConsoleProperties(json: string, fetcher: typeof fetch = fetch): Promise<GscSite[]> {
  const token = await googleServiceToken(json, fetcher);
  const body = await request(fetcher, SITES_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, { tokenFailure: 'google_sites_rejected', notFound: 'google_sites_rejected' });
  return sitesFromBody(body);
}

function validCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

// Validates one report row. A row that cannot be read honestly is rejected and
// counted; it is never coerced into a zero measurement.
export function parseSearchAnalyticsRow(raw: unknown): SearchAnalyticsRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as { keys?: unknown; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown };
  const clicks = validCount(row.clicks);
  const impressions = validCount(row.impressions);
  if (clicks === null || impressions === null) return null;
  const ctr = typeof row.ctr === 'number' && Number.isFinite(row.ctr) && row.ctr >= 0 && row.ctr <= 1
    ? row.ctr
    : (impressions > 0 ? clicks / impressions : 0);
  const position = typeof row.position === 'number' && Number.isFinite(row.position) && row.position >= 0
    ? row.position
    : null;
  const keys = row.keys === undefined ? [] : row.keys;
  // Every report this Worker issues groups by at least one dimension (date first),
  // so a keyless row is not a measurement we can attribute to a day.
  if (!Array.isArray(keys) || keys.length === 0 || keys.some(key => typeof key !== 'string')) return null;
  return { keys: keys as string[], clicks, impressions, ctr, position };
}

export class GscClient {
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly serviceAccountJson: string, private readonly fetcher: typeof fetch = fetch) {}

  token(): Promise<string> {
    this.tokenPromise ??= googleServiceToken(this.serviceAccountJson, this.fetcher);
    return this.tokenPromise;
  }

  async listProperties(): Promise<GscSite[]> {
    const token = await this.token();
    const body = await request(this.fetcher, SITES_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, { tokenFailure: 'google_sites_rejected', notFound: 'google_sites_rejected' });
    return sitesFromBody(body);
  }

  private async queryPage(
    property: string, body: QueryBody,
  ): Promise<{ rows: SearchAnalyticsRow[]; rejected: number; pageRows: number; firstIncomplete: string | null }> {
    const token = await this.token();
    const url = `${SEARCH_ANALYTICS_URL}/${encodeURIComponent(property)}/searchAnalytics/query`;
    const payload = await request(this.fetcher, url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, type: body.searchType ?? 'web' }),
    });
    const rawRows = payload.rows;
    if (rawRows !== undefined && !Array.isArray(rawRows)) throw new GscError('invalid_response');
    const rows: SearchAnalyticsRow[] = [];
    let rejected = 0;
    for (const raw of rawRows ?? []) {
      const row = parseSearchAnalyticsRow(raw);
      if (row) rows.push(row); else rejected += 1;
    }
    const metadata = payload.metadata;
    const firstIncomplete = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as { first_incomplete_date?: unknown }).first_incomplete_date
      : undefined;
    return {
      rows,
      rejected,
      pageRows: rawRows ? rawRows.length : 0,
      firstIncomplete: typeof firstIncomplete === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(firstIncomplete) ? firstIncomplete : null,
    };
  }

  // Fetches up to MAX_ROWS_PER_REPORT rows. Totals reports use a different
  // dimension set than query/page reports, so a partial detail report can never
  // be mistaken for the property total.
  async query(property: string, body: QueryBody): Promise<SearchAnalyticsResult> {
    const rowLimit = body.rowLimit ?? ROW_LIMIT;
    const rows: SearchAnalyticsRow[] = [];
    let requests = 0;
    let truncated = false;
    let rejected = 0;
    let firstIncomplete: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.queryPage(property, { ...body, rowLimit, startRow: page * rowLimit });
      requests += 1;
      rows.push(...result.rows);
      rejected += result.rejected;
      firstIncomplete ??= result.firstIncomplete;
      if (result.pageRows < rowLimit) { truncated = false; break; }
      truncated = page === MAX_PAGES - 1;
    }
    return { rows, truncated, first_incomplete_date: firstIncomplete, requests, rejected_rows: rejected };
  }
}

