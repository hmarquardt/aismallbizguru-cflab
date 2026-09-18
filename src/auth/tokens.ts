import type { MiddlewareHandler } from 'hono';
import type { ContextEnv, Scope } from '../types';
import { ApiError, invalid, strings } from '../http';

export const SCOPES: Scope[] = ['records:read', 'records:write', 'files:read', 'files:write', 'proxy:use'];
export function scopes(value: unknown): Scope[] {
  const values = strings(value, SCOPES.length);
  if (!values.length || values.some(v => !SCOPES.includes(v as Scope))) invalid('Invalid scopes');
  return values as Scope[];
}
export async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function newToken(): string {
  return 'cfl_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export const authenticate: MiddlewareHandler<ContextEnv> = async (c, next) => {
  const match = /^Bearer (cfl_[0-9a-f]{64})$/i.exec(c.req.header('Authorization') ?? '');
  if (!match?.[1]) throw new ApiError(401, 'unauthorized', 'Invalid or missing bearer token');
  const token = await c.env.DB.prepare('SELECT scopes_json FROM api_tokens WHERE app_id = ? AND token_hash = ? AND revoked_at IS NULL')
    .bind(c.get('app').id, await hashToken(match[1])).first<{ scopes_json: string }>();
  if (!token) throw new ApiError(401, 'unauthorized', 'Invalid or missing bearer token');
  c.set('scopes', scopes(JSON.parse(token.scopes_json)));
  await next();
};
export function requireScope(scope: Scope): MiddlewareHandler<ContextEnv> {
  return async (c, next) => {
    if (!c.get('scopes').includes(scope)) throw new ApiError(403, 'insufficient_scope', `Requires ${scope}`);
    await next();
  };
}
