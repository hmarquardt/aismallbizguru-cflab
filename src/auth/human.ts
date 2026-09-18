import type { MiddlewareHandler } from 'hono';
import type { Bindings, ContextEnv, HumanUser, Membership, Scope, UserRow } from '../types';
import { ApiError } from '../http';
import { hashToken, randomHex } from './crypto';

export const HUMAN_TOKEN_PREFIX = 'cflu_';
export const HUMAN_TOKEN_PATTERN = /^cflu_[0-9a-f]{64}$/;
export const RESET_TOKEN_PREFIX = 'cflr_';
export const RESET_TOKEN_PATTERN = /^cflr_[0-9a-f]{64}$/;
export const READ_SCOPES: Scope[] = ['records:read', 'files:read'];
export const WRITE_SCOPES: Scope[] = ['records:read', 'records:write', 'files:read', 'files:write', 'proxy:use'];
const SESSION_TTL_DEFAULT = 604_800;
const RESET_TTL_DEFAULT = 1_800;
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

export function newHumanToken(): string { return HUMAN_TOKEN_PREFIX + randomHex(32); }
export function newResetToken(): string { return RESET_TOKEN_PREFIX + randomHex(32); }

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_input', 'Invalid email');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
    throw new ApiError(400, 'invalid_input', 'Invalid email');
  }
  return email;
}
function ttl(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
export function sessionTtlSeconds(env: Bindings): number {
  return ttl(env.AUTH_SESSION_TTL_SECONDS, SESSION_TTL_DEFAULT, 300, 2_592_000);
}
export function resetTtlSeconds(env: Bindings): number {
  return ttl(env.AUTH_RESET_TTL_SECONDS, RESET_TTL_DEFAULT, 300, 86_400);
}
export function safeUser(row: Pick<UserRow, 'id' | 'email' | 'active' | 'is_admin'>): HumanUser {
  return { id: row.id, email: row.email, active: !!row.active, is_admin: !!row.is_admin };
}

export interface SessionUser extends HumanUser {
  session_id: string;
  expires_at: string;
}
export async function sessionUser(env: Bindings, rawToken: string): Promise<SessionUser> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.active, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`,
  ).bind(await hashToken(rawToken), now).first<{ session_id: string; expires_at: string; id: string; email: string; active: number; is_admin: number }>();
  if (!row) throw new ApiError(401, 'unauthorized', 'Invalid or expired session');
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
    .bind(now, row.session_id, new Date(Date.now() - LAST_SEEN_INTERVAL_MS).toISOString()).run();
  return { session_id: row.session_id, expires_at: row.expires_at, id: row.id, email: row.email, active: true, is_admin: !!row.is_admin };
}
function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}
export async function sessionFromRequest(c: { req: { header(name: string): string | undefined }; env: Bindings }): Promise<SessionUser> {
  const raw = bearer(c.req.header('Authorization'));
  if (!raw || !HUMAN_TOKEN_PATTERN.test(raw)) throw new ApiError(401, 'unauthorized', 'Invalid or expired session');
  return await sessionUser(c.env, raw);
}
export const requireHuman: MiddlewareHandler<ContextEnv> = async (c, next) => {
  const user = await sessionFromRequest(c);
  c.set('user', user);
  await next();
};
export const requireHumanAdmin: MiddlewareHandler<ContextEnv> = async (c, next) => {
  const user = await sessionFromRequest(c);
  if (!user.is_admin) throw new ApiError(403, 'forbidden', 'Administrator access required');
  c.set('user', user);
  await next();
};

export async function createSession(env: Bindings, userId: string): Promise<{ token: string; expires_at: string }> {
  const token = newHumanToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds(env) * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .bind(crypto.randomUUID(), userId, await hashToken(token), now.toISOString(), expiresAt).run();
  return { token, expires_at: expiresAt };
}
export async function revokeSession(env: Bindings, rawToken: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?')
    .bind(new Date().toISOString(), await hashToken(rawToken)).run();
}
export async function revokeAllSessions(env: Bindings, userId: string): Promise<number> {
  const result = await env.DB.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), userId).run();
  return result.meta.changes;
}
export async function issueResetToken(env: Bindings, userId: string): Promise<{ token: string; expires_at: string }> {
  const token = newResetToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + resetTtlSeconds(env) * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now.toISOString(), userId),
    env.DB.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, await hashToken(token), now.toISOString(), expiresAt),
  ]);
  return { token, expires_at: expiresAt };
}

export async function membershipsFor(db: D1Database, userId: string): Promise<Membership[]> {
  const { results } = await db.prepare('SELECT app_id, access FROM project_memberships WHERE user_id = ? ORDER BY app_id')
    .bind(userId).all<{ app_id: string; access: 'read' | 'write' }>();
  return results.map(row => ({ app_id: row.app_id, access: row.access }));
}
export async function appScopesFor(env: Bindings, user: HumanUser, appId: string): Promise<Scope[]> {
  if (user.is_admin) return WRITE_SCOPES;
  const row = await env.DB.prepare('SELECT access FROM project_memberships WHERE user_id = ? AND app_id = ?')
    .bind(user.id, appId).first<{ access: 'read' | 'write' }>();
  if (!row) throw new ApiError(403, 'forbidden', 'No access to this project');
  return row.access === 'write' ? WRITE_SCOPES : READ_SCOPES;
}
