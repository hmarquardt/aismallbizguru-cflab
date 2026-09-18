import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { requireScope } from '../auth/tokens';
import { ApiError, object, readLimited, slug, string } from '../http';
import { proxyConfig } from '../proxy/policy';
import { assertPublicDns } from '../proxy/dns';

export const proxy = new Hono<ContextEnv>();
proxy.all('/:source', requireScope('proxy:use'), async c => {
  const source = slug(c.req.param('source'));
  const row = await c.env.DB.prepare('SELECT config_json FROM proxy_sources WHERE app_id = ? AND slug = ? AND active = 1')
    .bind(c.get('app').id, source).first<{ config_json: string }>();
  if (!row) throw new ApiError(404, 'proxy_not_found', 'Proxy source not found');
  const config = proxyConfig(JSON.parse(row.config_json), c.env.PROXY_ALLOWED_HOSTS);
  if (!config.methods.includes(c.req.method)) throw new ApiError(405, 'method_not_allowed', 'Method not allowed');
  const destination = new URL(config.base_url);
  const incoming = new URL(c.req.url).searchParams;
  for (const [key, value] of incoming) {
    if (!config.query_params.includes(key) || incoming.getAll(key).length !== 1 || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new ApiError(400, 'invalid_query', 'Unapproved, repeated, or invalid query parameter');
    }
    destination.searchParams.set(key, value);
  }
  const headers = new Headers(config.headers);
  if (Object.keys(config.secret_headers).length) {
    let secrets: Record<string, unknown>;
    try { secrets = object(JSON.parse(c.env.PROXY_SECRETS ?? '{}')); }
    catch { throw new ApiError(503, 'proxy_configuration', 'Proxy secrets unavailable'); }
    for (const [header, name] of Object.entries(config.secret_headers)) {
      if (typeof secrets[name] !== 'string') throw new ApiError(503, 'proxy_configuration', 'Proxy secret unavailable');
      headers.set(header, string(secrets[name], 'secret', 4096));
    }
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ApiError(504, 'upstream_timeout', 'Upstream timed out')); }, config.timeout_ms);
  });
  const operation = async () => {
    await assertPublicDns(destination.hostname);
    controller.signal.throwIfAborted();
    const response = await fetch(destination, { method: 'GET', headers, redirect: 'manual', signal: controller.signal, cache: 'no-store' });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!response.ok || !contentType || !config.response_types.includes(contentType)) {
      await response.body?.cancel();
      throw new ApiError(502, 'upstream_response', 'Upstream returned an unacceptable response');
    }
    // Complete the bounded read before replying, so oversized/late responses remain JSON errors.
    let bytes: Uint8Array;
    try { bytes = await readLimited(response.body, config.max_response_bytes); }
    catch (error) {
      if (error instanceof ApiError && error.status === 413) throw new ApiError(502, 'upstream_too_large', 'Upstream response exceeds size limit');
      throw error;
    }
    return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
  };
  try { return await Promise.race([operation(), timeout]); }
  catch (error) {
    controller.abort();
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'upstream_failed', 'Upstream request failed');
  } finally { clearTimeout(timer); }
});
