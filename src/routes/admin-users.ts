import { Hono } from 'hono';
import type { ContextEnv, Membership, UserRow } from '../types';
import { ApiError, boolean, fields, id, invalid, jsonBody, slug } from '../http';
import { hashToken } from '../auth/crypto';
import { issueResetToken, membershipsFor, normalizeEmail, revokeAllSessions } from '../auth/human';
import { resetUrl, sendAuthMail } from '../auth/mail';
import { logAuth } from './auth';

function userOutput(row: UserRow, memberships: Membership[]) {
  return {
    id: row.id, email: row.email, active: !!row.active, is_admin: !!row.is_admin, has_password: !!row.password_hash,
    created_at: row.created_at, updated_at: row.updated_at, password_changed_at: row.password_changed_at, last_login_at: row.last_login_at,
    memberships,
  };
}
async function membershipsByUser(db: D1Database, userIds: string[]): Promise<Map<string, Membership[]>> {
  const map = new Map<string, Membership[]>();
  if (!userIds.length) return map;
  const { results } = await db.prepare(
    `SELECT user_id, app_id, access FROM project_memberships WHERE user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY app_id`,
  ).bind(...userIds).all<{ user_id: string; app_id: string; access: 'read' | 'write' }>();
  for (const row of results) {
    const list = map.get(row.user_id) ?? [];
    list.push({ app_id: row.app_id, access: row.access });
    map.set(row.user_id, list);
  }
  return map;
}
async function findUser(db: D1Database, userId: string): Promise<UserRow> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (!row) throw new ApiError(404, 'user_not_found', 'User not found');
  return row;
}
export const adminUsers = new Hono<ContextEnv>();

adminUsers.get('/', async c => {
  const after = c.req.query('after') ?? '';
  if (after) id(after);
  const { results } = await c.env.DB.prepare('SELECT * FROM users WHERE id > ? ORDER BY id LIMIT 101').bind(after).all<UserRow>();
  const users = results.slice(0, 100);
  const memberships = await membershipsByUser(c.env.DB, users.map(user => user.id));
  return c.json({
    users: users.map(user => userOutput(user, memberships.get(user.id) ?? [])),
    next_cursor: results.length > 100 ? results[99]!.id : null,
  });
});

adminUsers.post('/', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['email', 'is_admin']);
  const email = normalizeEmail(body.email);
  const isAdmin = body.is_admin === undefined ? false : boolean(body.is_admin);
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  try {
    await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
      .bind(userId, email, isAdmin ? 1 : 0, now, now).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) {
      throw new ApiError(409, 'email_exists', 'A user with that email already exists');
    }
    throw error;
  }
  logAuth('user_created', 'ok', userId);
  return c.json(userOutput({
    id: userId, email, password_hash: null, active: 1, is_admin: isAdmin ? 1 : 0,
    created_at: now, updated_at: now, password_changed_at: null, last_login_at: null,
  }, []), 201);
});

adminUsers.get('/:id', async c => {
  const row = await findUser(c.env.DB, id(c.req.param('id')));
  return c.json(userOutput(row, await membershipsFor(c.env.DB, row.id)));
});

adminUsers.patch('/:id', async c => {
  const userId = id(c.req.param('id'));
  const body = await jsonBody(c.req.raw); fields(body, ['active', 'is_admin']);
  if (!Object.keys(body).length) invalid('At least one field is required');
  const row = await findUser(c.env.DB, userId);
  const active = body.active === undefined ? !!row.active : boolean(body.active);
  const isAdmin = body.is_admin === undefined ? !!row.is_admin : boolean(body.is_admin);
  if (row.is_admin && row.active && (!active || !isAdmin)) {
    const other = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1 AND id != ?')
      .bind(userId).first<{ n: number }>();
    if (!other?.n) throw new ApiError(409, 'last_admin', 'At least one active administrator is required');
  }
  const now = new Date().toISOString();
  const statements = [c.env.DB.prepare('UPDATE users SET active = ?, is_admin = ?, updated_at = ? WHERE id = ?')
    .bind(active ? 1 : 0, isAdmin ? 1 : 0, now, userId)];
  if (row.active && !active) {
    statements.push(c.env.DB.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').bind(now, userId));
  }
  await c.env.DB.batch(statements);
  if (row.active && !active) logAuth('user_deactivated', 'ok', userId);
  return c.json(userOutput({ ...row, active: active ? 1 : 0, is_admin: isAdmin ? 1 : 0, updated_at: now }, await membershipsFor(c.env.DB, userId)));
});

adminUsers.get('/:id/memberships', async c => {
  const userId = id(c.req.param('id'));
  await findUser(c.env.DB, userId);
  return c.json({ memberships: await membershipsFor(c.env.DB, userId) });
});

adminUsers.post('/:id/memberships', async c => {
  const userId = id(c.req.param('id'));
  const body = await jsonBody(c.req.raw); fields(body, ['app_id', 'access']);
  const appId = slug(body.app_id);
  if (body.access !== 'read' && body.access !== 'write') invalid('Access must be read or write');
  await findUser(c.env.DB, userId);
  const app = await c.env.DB.prepare('SELECT 1 FROM apps WHERE id = ?').bind(appId).first();
  if (!app) throw new ApiError(404, 'app_not_found', 'App not found');
  await c.env.DB.prepare(
    'INSERT INTO project_memberships (user_id, app_id, access, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, app_id) DO UPDATE SET access = excluded.access',
  ).bind(userId, appId, body.access, new Date().toISOString()).run();
  return c.json({ user_id: userId, app_id: appId, access: body.access });
});

adminUsers.delete('/:id/memberships/:appId', async c => {
  const userId = id(c.req.param('id'));
  const appId = slug(c.req.param('appId'));
  await findUser(c.env.DB, userId);
  const result = await c.env.DB.prepare('DELETE FROM project_memberships WHERE user_id = ? AND app_id = ?').bind(userId, appId).run();
  if (!result.meta.changes) throw new ApiError(404, 'membership_not_found', 'Membership not found');
  return c.body(null, 204);
});

adminUsers.post('/:id/revoke-sessions', async c => {
  const userId = id(c.req.param('id'));
  await findUser(c.env.DB, userId);
  const revoked = await revokeAllSessions(c.env, userId);
  logAuth('sessions_revoked', 'ok', userId);
  return c.json({ revoked });
});

adminUsers.post('/:id/send-password-setup', async c => {
  const userId = id(c.req.param('id'));
  const user = await findUser(c.env.DB, userId);
  if (!user.active) throw new ApiError(409, 'user_inactive', 'User is inactive');
  const reset = await issueResetToken(c.env, userId);
  try {
    const url = resetUrl(c.env, reset.token);
    await sendAuthMail(c.env, user.email, 'CFLab password setup',
      `An administrator created or reset your CFLab account.\n\nUse this link within 30 minutes to choose a password:\n${url}\n\nIf you did not expect this, ignore this message.`);
  } catch (error) {
    await c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?')
      .bind(new Date().toISOString(), await hashToken(reset.token)).run();
    throw error;
  }
  logAuth('password_setup_sent', 'ok', userId);
  return c.json({ ok: true, expires_at: reset.expires_at });
});
