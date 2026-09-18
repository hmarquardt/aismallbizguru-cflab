import { ApiError, boolean, fields, integer, object, string, strings } from '../http';

export interface ProxyConfig {
  base_url: string;
  methods: string[];
  query_params: string[];
  headers: Record<string, string>;
  secret_headers: Record<string, string>;
  response_types: string[];
  max_response_bytes: number;
  timeout_ms: number;
  cache_ttl: number;
}
export function safeUrl(value: unknown, allowedHosts: string): URL {
  const raw = string(value, 'base_url', 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(400, 'unsafe_upstream', 'Invalid upstream URL'); }
  const host = url.hostname;
  const blocked = /(^|\.)(localhost|local|internal|test|invalid|onion|arpa)$/.test(host)
    || host === 'metadata.google.internal' || host === 'metadata.google.com'
    || host === 'cloudflare.internal' || host.endsWith('.cloudflare.internal')
    || host.endsWith('.workers.dev');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || blocked || raw.includes('\\') || !allowedHosts.split(',').map(s => s.trim()).includes(host)) {
    throw new ApiError(400, 'unsafe_upstream', 'Upstream must be an approved public HTTPS endpoint');
  }
  return url;
}
function headerMap(value: unknown, secret: boolean): Record<string, string> {
  const input = object(value ?? {});
  if (Object.keys(input).length > 16) throw new ApiError(400, 'invalid_input', 'Too many headers');
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(lower) || ['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'forwarded'].includes(lower)
      || lower.startsWith('cf-') || lower.startsWith('x-forwarded-') || (!secret && lower === 'authorization')) {
      throw new ApiError(400, 'invalid_input', 'Disallowed upstream header');
    }
    result[lower] = string(value, 'header value', 1024);
    if (secret && !/^[A-Z][A-Z0-9_]{0,63}$/.test(result[lower]!)) throw new ApiError(400, 'invalid_input', 'Invalid secret reference');
  }
  return result;
}
export function proxyConfig(value: unknown, allowedHosts: string): ProxyConfig {
  const input = object(value);
  fields(input, ['base_url', 'methods', 'query_params', 'headers', 'secret_headers', 'response_types', 'max_response_bytes', 'timeout_ms', 'cache_ttl']);
  const baseUrl = safeUrl(input.base_url, allowedHosts).href;
  const methods = strings(input.methods ?? ['GET']);
  if (!methods.length || methods.some(m => m !== 'GET')) throw new ApiError(400, 'invalid_input', 'MVP proxy sources support GET only');
  const queryParams = strings(input.query_params ?? []);
  if (queryParams.some(k => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) || /url|uri|host|target|destination|redirect|callback|endpoint/i.test(k))) {
    throw new ApiError(400, 'invalid_input', 'Unsafe query parameter name');
  }
  const responseTypes = strings(input.response_types ?? ['application/json']);
  if (!responseTypes.length || responseTypes.some(t => !['application/json', 'text/plain', 'text/csv', 'application/geo+json'].includes(t))) {
    throw new ApiError(400, 'invalid_input', 'Unsupported response type');
  }
  return { base_url: baseUrl, methods, query_params: queryParams,
    headers: headerMap(input.headers, false), secret_headers: headerMap(input.secret_headers, true), response_types: responseTypes,
    max_response_bytes: integer(input.max_response_bytes ?? 1024 * 1024, 1, 2 * 1024 * 1024),
    timeout_ms: integer(input.timeout_ms ?? 5000, 100, 10000),
    // Explicitly disabled in v1; no shared authenticated response cache.
    cache_ttl: integer(input.cache_ttl ?? 0, 0, 0) };
}
export function sourceInput(value: unknown, allowedHosts: string) {
  const input = object(value); fields(input, ['active', 'config']);
  return { active: boolean(input.active ?? true), config: proxyConfig(input.config, allowedHosts) };
}
