import type { MiddlewareHandler } from 'hono';
import type { ContextEnv, Scope } from '../types';
import { ApiError, invalid, strings } from '../http';
import { hashToken, randomHex } from './crypto';
import { HUMAN_TOKEN_PATTERN, appScopesFor, sessionUser } from './human';

export { hashToken } from './crypto';

export const SCOPES: Scope[] = ['records:read', 'records:write', 'files:read', 'files:write', 'proxy:use'];
export function scopes(value: unknown): Scope[] {
  const values = strings(value, SCOPES.length);
  if (!values.length || values.some(v => !SCOPES.includes(v as Scope))) invalid('Invalid scopes');
  return values as Scope[];
}
export function newToken(): string {
  return 'cfl_' + randomHex(32);
}
// Application routes accept either a machine API token or a human session.
// Machine scopes stay exactly as issued; human scopes derive from admin status or project membership.
export const authenticate: MiddlewareHandler<ContextEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const human = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (human && HUMAN_TOKEN_PATTERN.test(human)) {
    const user = await sessionUser(c.env, human);
    const effective = await appScopesFor(c.env, user, c.get('app').id);
    c.set('user', user);
    c.set('scopes', effective);
    await next();
    return;
  }
  const match = /^Bearer (cfl_[0-9a-f]{64})$/i.exec(header);
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
