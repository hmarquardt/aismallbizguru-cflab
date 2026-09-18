import { Hono, type MiddlewareHandler } from 'hono';
import type { ContextEnv } from '../types';
import { ApiError, fields, invalid, jsonBody } from '../http';
import { assertPassword, dummyPasswordHash, hashPassword, verifyPassword } from '../auth/passwords';
import { hashToken } from '../auth/crypto';
import {
  HUMAN_TOKEN_PATTERN, RESET_TOKEN_PATTERN, createSession, issueResetToken, membershipsFor,
  normalizeEmail, requireHuman, revokeSession, safeUser,
} from '../auth/human';
import { resetUrl, sendAuthMail } from '../auth/mail';
import { enforceRateLimit, rateLimitKey } from '../auth/ratelimit';

const AUTH_METHODS = ['GET', 'POST'];
const AUTH_HEADERS = ['authorization', 'content-type'];
export function logAuth(action: string, result: string, userId?: string) {
  // Authentication events only: never emails, passwords, hashes, or tokens.
  console.log(JSON.stringify({ event: 'auth', action, result, ...(userId ? { user_id: userId } : {}) }));
}

// CORS is browser hygiene, not authorization: origins must already be registered
// application origins (or the same origin), and membership checks still apply later.
export const authCors: MiddlewareHandler<ContextEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin) { await next(); return; }
  const sameOrigin = origin === new URL(c.req.url).origin;
  const registered = sameOrigin || await c.env.DB.prepare(
    'SELECT 1 FROM app_origins o JOIN apps a ON a.id = o.app_id WHERE o.origin = ? AND a.active = 1 LIMIT 1',
  ).bind(origin).first();
  if (!registered) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  if (c.req.method === 'OPTIONS') {
    const method = c.req.header('Access-Control-Request-Method');
    const headers = (c.req.header('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!method || !AUTH_METHODS.includes(method) || headers.some(h => !AUTH_HEADERS.includes(h))) {
      throw new ApiError(403, 'preflight_denied', 'Preflight not allowed');
    }
    c.header('Access-Control-Allow-Methods', AUTH_METHODS.join(', '));
    c.header('Access-Control-Allow-Headers', AUTH_HEADERS.join(', '));
    c.header('Access-Control-Max-Age', '300');
    return c.body(null, 204);
  }
  await next();
  c.header('Access-Control-Allow-Origin', origin);
};

interface LoginRow { id: string; email: string; password_hash: string | null; active: number; is_admin: number; }
export const auth = new Hono<ContextEnv>();

auth.post('/login', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['email', 'password']);
  const email = normalizeEmail(body.email);
  if (typeof body.password !== 'string') invalid('Invalid password');
  await enforceRateLimit(c.env.RL_LOGIN, await rateLimitKey('login', email));
  const user = await c.env.DB.prepare('SELECT id, email, password_hash, active, is_admin FROM users WHERE email = ?')
    .bind(email).first<LoginRow>();
  let valid = false;
  if (user && user.active === 1 && user.password_hash) valid = await verifyPassword(body.password, user.password_hash);
  else await verifyPassword(body.password, await dummyPasswordHash());
  if (!valid || !user) {
    logAuth('login', 'denied');
    throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const session = await createSession(c.env, user.id);
  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').bind(now, now, user.id).run();
  logAuth('login', 'ok', user.id);
  return c.json({
    token: session.token,
    token_type: 'Bearer',
    expires_at: session.expires_at,
    user: safeUser(user),
    memberships: await membershipsFor(c.env.DB, user.id),
  });
});

auth.post('/logout', async c => {
  const raw = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
  if (raw && HUMAN_TOKEN_PATTERN.test(raw)) {
    await revokeSession(c.env, raw);
    logAuth('logout', 'ok');
  }
  return c.body(null, 204);
});

auth.get('/me', requireHuman, async c => {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT id, email, active, is_admin, created_at, last_login_at FROM users WHERE id = ?')
    .bind(user.id).first<{ id: string; email: string; active: number; is_admin: number; created_at: string; last_login_at: string | null }>();
  if (!row) throw new ApiError(401, 'unauthorized', 'Invalid or expired session');
  return c.json({
    user: { ...safeUser(row), created_at: row.created_at, last_login_at: row.last_login_at },
    memberships: await membershipsFor(c.env.DB, user.id),
  });
});

auth.post('/change-password', requireHuman, async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['current_password', 'new_password']);
  if (typeof body.current_password !== 'string') invalid('Invalid current password');
  const next = assertPassword(body.new_password);
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string | null }>();
  if (!row?.password_hash || !(await verifyPassword(body.current_password, row.password_hash))) {
    logAuth('password_change', 'denied', user.id);
    throw new ApiError(401, 'invalid_credentials', 'Current password is incorrect');
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(next), now, now, user.id),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').bind(now, user.id),
  ]);
  logAuth('password_change', 'ok', user.id);
  return c.json({ ok: true, sessions_revoked: true });
});

auth.post('/forgot-password', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['email']);
  const email = normalizeEmail(body.email);
  await enforceRateLimit(c.env.RL_RECOVERY, await rateLimitKey('forgot', email));
  const user = await c.env.DB.prepare('SELECT id, active FROM users WHERE email = ?').bind(email).first<{ id: string; active: number }>();
  if (user && user.active === 1) {
    const reset = await issueResetToken(c.env, user.id);
    try {
      const url = resetUrl(c.env, reset.token);
      await sendAuthMail(c.env, email, 'CFLab password reset',
        `A password reset was requested for your CFLab account.\n\nUse this link within 30 minutes:\n${url}\n\nIf you did not request this, ignore this message.`);
      logAuth('password_reset_requested', 'sent', user.id);
    } catch {
      console.error(JSON.stringify({ event: 'auth', action: 'password_reset_requested', result: 'mail_failed' }));
    }
  } else {
    logAuth('password_reset_requested', 'no_account');
  }
  return c.json({ ok: true, message: 'If that account exists, password reset instructions have been sent.' });
});

auth.post('/reset-password', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['token', 'password']);
  if (typeof body.token !== 'string' || !RESET_TOKEN_PATTERN.test(body.token)) throw new ApiError(400, 'invalid_token', 'Invalid or expired reset token');
  const next = assertPassword(body.password);
  await enforceRateLimit(c.env.RL_RESET, await rateLimitKey('reset', body.token));
  const row = await c.env.DB.prepare('SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?')
    .bind(await hashToken(body.token)).first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();
  const now = new Date().toISOString();
  if (!row || row.used_at || row.expires_at <= now) throw new ApiError(400, 'invalid_token', 'Invalid or expired reset token');
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(next), now, now, row.user_id),
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, row.id),
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, row.user_id),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').bind(now, row.user_id),
  ]);
  if (!results[1]?.meta.changes) throw new ApiError(400, 'invalid_token', 'Invalid or expired reset token');
  logAuth('password_reset_completed', 'ok', row.user_id);
  return c.json({ ok: true });
});
