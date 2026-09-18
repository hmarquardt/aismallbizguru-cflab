import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../src/local';
import type { Bindings } from '../src/types';
import { SCRYPT_N, SCRYPT_P, SCRYPT_R, hashPassword, passwordProblem, verifyPassword } from '../src/auth/passwords';
import { hashToken } from '../src/auth/crypto';
import { HUMAN_TOKEN_PATTERN } from '../src/auth/human';

const adminSecret = 'local-test-only-secret-with-32-characters';
const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const sentMail: { from: string; to: string; subject: string; text: string }[] = [];
const testEnv = {
  ...bindings,
  DEV_ADMIN_TOKEN: adminSecret,
  AUTH_FROM_EMAIL: 'noreply@cflab.example',
  AUTH_PUBLIC_BASE_URL: 'https://cflab.example',
  AUTH_SESSION_TTL_SECONDS: '604800',
  AUTH_RESET_TTL_SECONDS: '1800',
  EMAIL: { send: async (message: { from: string; to: string; subject: string; text: string }) => { sentMail.push(message); return { messageId: 'test' }; } },
  RL_LOGIN: { limit: async () => ({ success: true }) },
  RL_RECOVERY: { limit: async () => ({ success: true }) },
  RL_RESET: { limit: async () => ({ success: true }) },
} as unknown as Bindings & { DEV_ADMIN_TOKEN: string };

async function call(path: string, method = 'GET', body?: unknown, bearer?: string | null, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);
}
const admin = (path: string, method = 'GET', body?: unknown) => call(`/api/admin${path}`, method, body, adminSecret);

async function createUser(email: string, password: string | null = null, options: { is_admin?: boolean; active?: boolean } = {}) {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(userId, email.trim().toLowerCase(), password === null ? null : await hashPassword(password), options.active === false ? 0 : 1, options.is_admin ? 1 : 0, now, now).run();
  return userId;
}
async function addMembership(userId: string, appId: string, access: 'read' | 'write') {
  await bindings.DB.prepare('INSERT INTO project_memberships (user_id, app_id, access, created_at) VALUES (?, ?, ?, ?)')
    .bind(userId, appId, access, new Date().toISOString()).run();
}
async function loginAs(email: string, password: string) {
  const response = await call('/api/auth/login', 'POST', { email, password });
  return { response, body: await response.json<{ token?: string; expires_at?: string; user?: { id: string; is_admin: boolean }; memberships?: unknown[]; error?: { code: string } }>() };
}
const password = 'correct horse battery staple';

beforeAll(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sentMail.length = 0;
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM password_reset_tokens'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM project_memberships'),
    bindings.DB.prepare('DELETE FROM users'),
    bindings.DB.prepare('DELETE FROM files'),
    bindings.DB.prepare('DELETE FROM apps'),
  ]);
  for (const app of ['demo', 'other']) {
    const response = await admin('/apps', 'POST', { id: app, name: app, origins: ['https://client.example'] });
    expect(response.status).toBe(201);
  }
});
afterEach(() => { vi.restoreAllMocks(); });

describe('password hashing and policy', () => {
  it('hashes with scrypt at the documented parameters and verifies', async () => {
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$8192\$8\$10\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash.split('$').slice(1, 4)).toEqual([String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P)]);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password + 'x', hash)).toBe(false);
  });
  it('uses a unique salt per hash', async () => {
    expect(await hashPassword(password)).not.toBe(await hashPassword(password));
  });
  it.each([
    null, undefined, '', 'x',
    'scrypt$8192$8$10$only-five-parts',
    'pbkdf2-sha256$600000$c2FsdA==$a2V5',
    'scrypt$8191$8$10$c2FsdA==$a2V5',
    'scrypt$8192$0$10$c2FsdA==$a2V5',
    'scrypt$8192$8$99$c2FsdA==$a2V5',
    'scrypt$8192$8$10$c2FsdA==$a2V5',
    'scrypt$8192$8$10$!!!$!!!',
    'scrypt$1048576$32$10$c2FsdA==$a2V5',
  ])('rejects malformed stored hash %j safely', async stored => {
    expect(await verifyPassword(password, stored)).toBe(false);
  });
  it('enforces the length-only policy and permits spaces and Unicode', () => {
    expect(passwordProblem('a'.repeat(14))).not.toBeNull();
    expect(passwordProblem('a'.repeat(15))).toBeNull();
    expect(passwordProblem('a'.repeat(128))).toBeNull();
    expect(passwordProblem('a'.repeat(129))).not.toBeNull();
    expect(passwordProblem('pass phrase with spaces & 🔒')).toBeNull();
    expect(passwordProblem(42)).not.toBeNull();
  });
  it('does not silently truncate passwords', async () => {
    const long = 'a'.repeat(128);
    const hash = await hashPassword(long);
    expect(await verifyPassword(long, hash)).toBe(true);
    expect(await verifyPassword(long + 'b', hash)).toBe(false);
  });
});

describe('login and sessions', () => {
  it('logs in, returns a cflu_ session, profile, memberships, and expiry', async () => {
    const userId = await createUser('Pilot@Example.com ', password, { is_admin: false });
    await addMembership(userId, 'demo', 'read');
    const { response, body } = await loginAs('pilot@example.com', password);
    expect(response.status).toBe(200);
    expect(body.token).toMatch(HUMAN_TOKEN_PATTERN);
    expect(body.user).toEqual({ id: userId, email: 'pilot@example.com', active: true, is_admin: false });
    expect(body.memberships).toEqual([{ app_id: 'demo', access: 'read' }]);
    expect(Date.parse(body.expires_at!)).toBeGreaterThan(Date.now() + 6.9 * 86400000);
  });
  it('stores only the session hash and updates last_login_at', async () => {
    const userId = await createUser('pilot@example.com', password);
    const { body } = await loginAs('pilot@example.com', password);
    const row = await bindings.DB.prepare('SELECT token_hash, user_id FROM sessions WHERE user_id = ?').bind(userId).first<{ token_hash: string; user_id: string }>();
    expect(row?.token_hash).toBe(await hashToken(body.token!));
    expect(row?.token_hash).not.toBe(body.token);
    expect(JSON.stringify(row)).not.toContain(body.token!);
    const user = await bindings.DB.prepare('SELECT last_login_at FROM users WHERE id = ?').bind(userId).first<{ last_login_at: string | null }>();
    expect(user?.last_login_at).toBeTruthy();
  });
  it.each([
    ['wrong password', 'pilot@example.com', 'wrong password value', false],
    ['nonexistent account', 'missing@example.com', password, false],
  ])('rejects %s with one generic response', async (_name, email, supplied, exists) => {
    if (exists) await createUser(email, password);
    const { response, body } = await loginAs(email, supplied);
    expect(response.status).toBe(401);
    expect(body.error?.code).toBe('invalid_credentials');
    expect(JSON.stringify(body)).not.toContain(password);
  });
  it('rejects inactive and passwordless accounts without revealing which', async () => {
    await createUser('inactive@example.com', password, { active: false });
    await createUser('nosetup@example.com', null);
    for (const email of ['inactive@example.com', 'nosetup@example.com']) {
      const { response, body } = await loginAs(email, password);
      expect(response.status).toBe(401);
      expect(body.error?.code).toBe('invalid_credentials');
    }
  });
  it('serves /me only with a live session and never exposes hashes', async () => {
    const userId = await createUser('pilot@example.com', password, { is_admin: true });
    const { body } = await loginAs('pilot@example.com', password);
    const me = await call('/api/auth/me', 'GET', undefined, body.token);
    expect(me.status).toBe(200);
    const text = await me.text();
    expect(text).toContain(userId);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain(await hashToken(body.token!));
    expect((await call('/api/auth/me', 'GET', undefined, null)).status).toBe(401);
    expect((await call('/api/auth/me', 'GET', undefined, 'cflu_' + '0'.repeat(64))).status).toBe(401);
  });
  it('revokes only the presented session on logout and is idempotent', async () => {
    await createUser('pilot@example.com', password);
    const first = (await loginAs('pilot@example.com', password)).body.token!;
    const second = (await loginAs('pilot@example.com', password)).body.token!;
    expect((await call('/api/auth/logout', 'POST', {}, first)).status).toBe(204);
    expect((await call('/api/auth/logout', 'POST', {}, first)).status).toBe(204);
    expect((await call('/api/auth/me', 'GET', undefined, first)).status).toBe(401);
    expect((await call('/api/auth/me', 'GET', undefined, second)).status).toBe(200);
  });
  it('rejects expired and revoked sessions', async () => {
    const userId = await createUser('pilot@example.com', password);
    const token = (await loginAs('pilot@example.com', password)).body.token!;
    await bindings.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(new Date(Date.now() - 1000).toISOString(), userId).run();
    expect((await call('/api/auth/me', 'GET', undefined, token)).status).toBe(401);
    const fresh = (await loginAs('pilot@example.com', password)).body.token!;
    await bindings.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ?').bind(new Date().toISOString(), userId).run();
    expect((await call('/api/auth/me', 'GET', undefined, fresh)).status).toBe(401);
  });
  it('rejects sessions of deactivated users', async () => {
    const userId = await createUser('pilot@example.com', password);
    const token = (await loginAs('pilot@example.com', password)).body.token!;
    await bindings.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(userId).run();
    expect((await call('/api/auth/me', 'GET', undefined, token)).status).toBe(401);
  });
  it('honors the configured session lifetime', async () => {
    await createUser('pilot@example.com', password);
    const response = await local.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pilot@example.com', password }),
    }), { ...testEnv, AUTH_SESSION_TTL_SECONDS: '300' });
    const body = await response.json<{ expires_at: string }>();
    const lifetime = Date.parse(body.expires_at) - Date.now();
    expect(lifetime).toBeGreaterThan(290_000);
    expect(lifetime).toBeLessThan(310_000);
  });
  it('change-password verifies the current password and revokes all sessions', async () => {
    await createUser('pilot@example.com', password);
    const token = (await loginAs('pilot@example.com', password)).body.token!;
    const other = (await loginAs('pilot@example.com', password)).body.token!;
    expect((await call('/api/auth/change-password', 'POST', { current_password: 'nope', new_password: 'a much longer new password' }, token)).status).toBe(401);
    expect((await call('/api/auth/change-password', 'POST', { current_password: password, new_password: 'short' }, token)).status).toBe(400);
    expect((await call('/api/auth/change-password', 'POST', { current_password: password, new_password: 'a much longer new password' }, token)).status).toBe(200);
    expect((await call('/api/auth/me', 'GET', undefined, token)).status).toBe(401);
    expect((await call('/api/auth/me', 'GET', undefined, other)).status).toBe(401);
    expect((await loginAs('pilot@example.com', password)).response.status).toBe(401);
    expect((await loginAs('pilot@example.com', 'a much longer new password')).response.status).toBe(200);
  });
});

describe('human and machine authorization', () => {
  it('lets admins reach admin APIs and any project without membership', async () => {
    await createUser('admin@example.com', password, { is_admin: true });
    const token = (await loginAs('admin@example.com', password)).body.token!;
    expect((await call('/api/admin/apps', 'GET', undefined, token)).status).toBe(200);
    expect((await call('/api/admin/users', 'GET', undefined, token)).status).toBe(200);
    expect((await call('/api/apps/demo/resources/notes/records', 'GET', undefined, token)).status).toBe(200);
    expect((await call('/api/apps/demo/resources/notes/records', 'POST', { data: { a: 1 } }, token)).status).toBe(201);
  });
  it('limits read members to reads and write members to project writes', async () => {
    const reader = await createUser('reader@example.com', password);
    await addMembership(reader, 'demo', 'read');
    const writer = await createUser('writer@example.com', password);
    await addMembership(writer, 'demo', 'write');
    const readToken = (await loginAs('reader@example.com', password)).body.token!;
    const writeToken = (await loginAs('writer@example.com', password)).body.token!;
    expect((await call('/api/apps/demo/resources/notes/records', 'GET', undefined, readToken)).status).toBe(200);
    expect((await call('/api/apps/demo/resources/notes/records', 'POST', { data: {} }, readToken)).status).toBe(403);
    expect((await call('/api/apps/demo/resources/notes/records', 'POST', { data: {} }, writeToken)).status).toBe(201);
    const upload = (path: string, token: string) => local.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'hello' }), testEnv);
    expect((await upload('/api/apps/demo/files', readToken)).status).toBe(403);
    expect((await upload('/api/apps/demo/files', writeToken)).status).toBe(201);
  });
  it('denies unassigned and cross-project access while machine tokens still work', async () => {
    const user = await createUser('reader@example.com', password);
    await addMembership(user, 'demo', 'write');
    const token = (await loginAs('reader@example.com', password)).body.token!;
    expect((await call('/api/apps/other/resources/notes/records', 'GET', undefined, token)).status).toBe(403);
    expect((await call('/api/apps/other/resources/notes/records', 'POST', { data: {} }, token)).status).toBe(403);
    const machine = await admin('/apps/other/tokens', 'POST', { name: 'svc', scopes: ['records:read'] });
    const machineToken = (await machine.json<{ token: string }>()).token;
    expect((await call('/api/apps/other/resources/notes/records', 'GET', undefined, machineToken)).status).toBe(200);
    expect((await call('/api/apps/other/resources/notes/records', 'POST', { data: {} }, machineToken)).status).toBe(403);
    expect((await call('/api/apps/demo/resources/notes/records', 'GET', undefined, machineToken)).status).toBe(401);
  });
  it('prevents project users from administering users or apps', async () => {
    const user = await createUser('reader@example.com', password);
    await addMembership(user, 'demo', 'write');
    const token = (await loginAs('reader@example.com', password)).body.token!;
    expect((await call('/api/admin/users', 'GET', undefined, token)).status).toBe(403);
    expect((await call('/api/admin/users', 'POST', { email: 'new@example.com' }, token)).status).toBe(403);
    expect((await call('/api/admin/apps', 'GET', undefined, token)).status).toBe(403);
    expect((await call('/api/admin/apps/demo/tokens', 'POST', { name: 'x', scopes: ['records:read'] }, token)).status).toBe(403);
  });
});

describe('password recovery', () => {
  it('returns one generic response for known, unknown, and inactive accounts', async () => {
    await createUser('known@example.com', password);
    await createUser('inactive@example.com', password, { active: false });
    const bodies: string[] = [];
    for (const email of ['known@example.com', 'missing@example.com', 'inactive@example.com']) {
      const response = await call('/api/auth/forgot-password', 'POST', { email });
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('If that account exists');
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.to).toBe('known@example.com');
  });
  it('emails an HTTPS reset link, stores only its hash, and uses the configured base URL', async () => {
    await createUser('known@example.com', password);
    const response = await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' }, null, { Host: 'evil.example' });
    expect(response.status).toBe(200);
    const mail = sentMail[0]!;
    expect(mail.text).toContain('https://cflab.example/reset-password?token=cflr_');
    expect(mail.text).not.toContain('evil.example');
    expect(mail.text).not.toContain(password);
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(mail.text)![1]!;
    const row = await bindings.DB.prepare('SELECT token_hash, used_at FROM password_reset_tokens').first<{ token_hash: string; used_at: string | null }>();
    expect(row?.token_hash).toBe(await hashToken(raw));
    expect(row?.token_hash).not.toBe(raw);
    expect(JSON.stringify(row)).not.toContain(raw);
  });
  it('resets the password, is single-use, and revokes all sessions', async () => {
    await createUser('known@example.com', password);
    const session = (await loginAs('known@example.com', password)).body.token!;
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'a brand new long password' })).status).toBe(200);
    expect((await call('/api/auth/me', 'GET', undefined, session)).status).toBe(401);
    expect((await loginAs('known@example.com', password)).response.status).toBe(401);
    expect((await loginAs('known@example.com', 'a brand new long password')).response.status).toBe(200);
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'another brand new password' })).status).toBe(400);
  });
  it('rejects wrong, expired, malformed, and policy-violating reset attempts', async () => {
    await createUser('known@example.com', password);
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    expect((await call('/api/auth/reset-password', 'POST', { token: 'cflr_' + '0'.repeat(64), password: 'a brand new long password' })).status).toBe(400);
    expect((await call('/api/auth/reset-password', 'POST', { token: 'bad', password: 'a brand new long password' })).status).toBe(400);
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'short' })).status).toBe(400);
    await bindings.DB.prepare('UPDATE password_reset_tokens SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'a brand new long password' })).status).toBe(400);
  });
  it('supports the admin setup flow for a newly created user', async () => {
    const created = await admin('/users', 'POST', { email: 'newbie@example.com' });
    expect(created.status).toBe(201);
    const user = await created.json<{ id: string; has_password: boolean; email: string }>();
    expect(user.has_password).toBe(false);
    expect((await admin(`/users/${user.id}/send-password-setup`, 'POST', {})).status).toBe(200);
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    expect((await loginAs('newbie@example.com', password)).response.status).toBe(401);
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password })).status).toBe(200);
    expect((await loginAs('newbie@example.com', password)).response.status).toBe(200);
  });
  it('stays generic when mail delivery fails but reports setup failures to admins', async () => {
    await createUser('known@example.com', password);
    const failing = { ...testEnv, EMAIL: { send: async () => { throw new Error('mail down'); } } };
    const response = await local.fetch(new Request('http://localhost/api/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'known@example.com' }),
    }), failing);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('If that account exists');
    const created = await admin('/users', 'POST', { email: 'newbie@example.com' });
    const user = await created.json<{ id: string }>();
    const setup = await local.fetch(new Request(`http://localhost/api/admin/users/${user.id}/send-password-setup`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' }, body: '{}',
    }), failing);
    expect(setup.status).toBe(503);
    expect(await bindings.DB.prepare('SELECT used_at FROM password_reset_tokens WHERE user_id = ?').bind(user.id).first<{ used_at: string | null }>()).toMatchObject({ used_at: expect.any(String) });
  });
});

describe('admin user management', () => {
  it('creates users with normalized email and rejects duplicates case-insensitively', async () => {
    const first = await admin('/users', 'POST', { email: '  Mixed.Case+tag@Example.COM ' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ email: 'mixed.case+tag@example.com', active: true, is_admin: false, has_password: false, memberships: [] });
    expect((await admin('/users', 'POST', { email: 'mixed.case+tag@example.com' })).status).toBe(409);
    expect((await admin('/users', 'POST', { email: 'not-an-email' })).status).toBe(400);
  });
  it('lists users without password hashes and shows memberships', async () => {
    const userId = await createUser('pilot@example.com', password, { is_admin: true });
    await addMembership(userId, 'demo', 'read');
    const list = await admin('/users');
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain('password_hash');
    expect(text).toContain('pilot@example.com');
    expect(JSON.parse(text)).toMatchObject({ users: [{ id: userId, has_password: true, memberships: [{ app_id: 'demo', access: 'read' }] }] });
  });
  it('assigns, updates, and removes memberships only for real apps', async () => {
    const userId = await createUser('pilot@example.com', password);
    expect((await admin(`/users/${userId}/memberships`, 'POST', { app_id: 'demo', access: 'read' })).status).toBe(200);
    expect((await admin(`/users/${userId}/memberships`, 'POST', { app_id: 'demo', access: 'write' })).status).toBe(200);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM project_memberships WHERE user_id = ?').bind(userId).first('n')).toBe(1);
    expect((await admin(`/users/${userId}/memberships`, 'POST', { app_id: 'missing', access: 'read' })).status).toBe(404);
    expect((await admin(`/users/${userId}/memberships`, 'POST', { app_id: 'demo', access: 'admin' })).status).toBe(400);
    expect((await admin(`/users/${userId}/memberships/demo`, 'DELETE')).status).toBe(204);
    expect((await admin(`/users/${userId}/memberships/demo`, 'DELETE')).status).toBe(404);
    expect((await admin('/users/00000000-0000-4000-8000-000000000000/memberships', 'POST', { app_id: 'demo', access: 'read' })).status).toBe(404);
  });
  it('deactivates users, revokes sessions, and reactivates without granting access', async () => {
    const userId = await createUser('pilot@example.com', password);
    const token = (await loginAs('pilot@example.com', password)).body.token!;
    const patched = await admin(`/users/${userId}`, 'PATCH', { active: false });
    expect(patched.status).toBe(200);
    expect((await patched.json<{ active: boolean }>()).active).toBe(false);
    expect((await call('/api/auth/me', 'GET', undefined, token)).status).toBe(401);
    expect((await loginAs('pilot@example.com', password)).response.status).toBe(401);
    expect((await admin(`/users/${userId}`, 'PATCH', { active: true })).status).toBe(200);
    expect((await loginAs('pilot@example.com', password)).response.status).toBe(200);
  });
  it('revokes sessions explicitly and reports the count', async () => {
    const userId = await createUser('pilot@example.com', password);
    await loginAs('pilot@example.com', password);
    await loginAs('pilot@example.com', password);
    const revoked = await admin(`/users/${userId}/revoke-sessions`, 'POST', {});
    expect(await revoked.json()).toEqual({ revoked: 2 });
    expect((await admin(`/users/${userId}/revoke-sessions`, 'POST', {})).status).toBe(200);
  });
  it('protects the last active administrator', async () => {
    const first = await createUser('admin1@example.com', password, { is_admin: true });
    expect((await admin(`/users/${first}`, 'PATCH', { is_admin: false })).status).toBe(409);
    expect((await admin(`/users/${first}`, 'PATCH', { active: false })).status).toBe(409);
    await createUser('admin2@example.com', password, { is_admin: true });
    expect((await admin(`/users/${first}`, 'PATCH', { is_admin: false })).status).toBe(200);
    expect((await admin(`/users/${first}`, 'PATCH', { is_admin: true })).status).toBe(200);
  });
  it('rejects unauthenticated, machine-token, and unknown-user admin calls', async () => {
    expect((await call('/api/admin/users')).status).toBe(401);
    const machine = await admin('/apps/demo/tokens', 'POST', { name: 'svc', scopes: ['records:read'] });
    const machineToken = (await machine.json<{ token: string }>()).token;
    expect((await call('/api/admin/users', 'GET', undefined, machineToken)).status).toBe(401);
    expect((await admin('/users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await admin('/users/00000000-0000-4000-8000-000000000000', 'PATCH', { active: false })).status).toBe(404);
  });
});

describe('auth CORS', () => {
  it('allows registered and same origins on preflight and responses', async () => {
    const preflight = await call('/api/auth/login', 'OPTIONS', undefined, null, {
      Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
    const same = await call('/api/auth/login', 'OPTIONS', undefined, null, {
      Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    });
    expect(same.status).toBe(204);
    const response = await call('/api/auth/login', 'POST', { email: 'missing@example.com', password }, null, { Origin: 'https://client.example' });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
  });
  it('denies unknown origins and unsafe preflight methods without a wildcard', async () => {
    const unknown = await call('/api/auth/login', 'OPTIONS', undefined, null, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
    expect(unknown.status).toBe(403);
    expect(unknown.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const cases: Record<string, string>[] = [
      { Origin: 'https://client.example', 'Access-Control-Request-Method': 'DELETE' },
      { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin' },
    ];
    for (const headers of cases) {
      const response = await call('/api/auth/login', 'OPTIONS', undefined, null, headers);
      expect(response.status).toBe(403);
    }
    expect((await call('/api/auth/login', 'POST', { email: 'x@example.com', password }, null, { Origin: 'https://evil.example' })).status).toBe(403);
  });
  it('never treats CORS as authorization for project data', async () => {
    const userId = await createUser('reader@example.com', password);
    await addMembership(userId, 'demo', 'read');
    const token = (await loginAs('reader@example.com', password)).body.token!;
    expect((await call('/api/apps/demo/resources/notes/records', 'GET', undefined, token, { Origin: 'https://client.example' })).status).toBe(200);
    expect((await call('/api/apps/other/resources/notes/records', 'GET', undefined, token, { Origin: 'https://client.example' })).status).toBe(403);
  });
});

describe('rate limiting and mail configuration', () => {
  it('enforces the login, recovery, and reset limiters', async () => {
    await createUser('known@example.com', password);
    const limited = (name: 'RL_LOGIN' | 'RL_RECOVERY' | 'RL_RESET') => ({ ...testEnv, [name]: { limit: async () => ({ success: false }) } });
    const login = await local.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'known@example.com', password }),
    }), limited('RL_LOGIN'));
    expect(login.status).toBe(429);
    const forgot = await local.fetch(new Request('http://localhost/api/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'known@example.com' }),
    }), limited('RL_RECOVERY'));
    expect(forgot.status).toBe(429);
    expect(sentMail).toHaveLength(0);
    const reset = await local.fetch(new Request('http://localhost/api/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'cflr_' + '0'.repeat(64), password }),
    }), limited('RL_RESET'));
    expect(reset.status).toBe(429);
  });
  it('uses hashed, route-prefixed rate-limit keys instead of raw emails', async () => {
    const keys: string[] = [];
    const envWithSpy = { ...testEnv, RL_LOGIN: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } };
    await createUser('known@example.com', password);
    await local.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'known@example.com', password: 'wrong password here' }),
    }), envWithSpy);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^login:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain('known@example.com');
  });
  it('fails closed on unconfigured or unsafe mail settings without leaking details', async () => {
    await createUser('known@example.com', password);
    const noSender = await local.fetch(new Request('http://localhost/api/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'known@example.com' }),
    }), { ...testEnv, AUTH_FROM_EMAIL: '' });
    expect(noSender.status).toBe(200);
    expect(await noSender.text()).toContain('If that account exists');
    expect(sentMail).toHaveLength(0);
    const created = await admin('/users', 'POST', { email: 'newbie@example.com' });
    const user = await created.json<{ id: string }>();
    const badBase = await local.fetch(new Request(`http://localhost/api/admin/users/${user.id}/send-password-setup`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' }, body: '{}',
    }), { ...testEnv, AUTH_PUBLIC_BASE_URL: 'http://evil.example' });
    expect(badBase.status).toBe(503);
  });
});

describe('human-facing pages', () => {
  it.each(['/admin/login', '/admin/users', '/account', '/forgot-password', '/reset-password'])('serves %s as hardened HTML without credentials', async path => {
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const body = await response.text();
    expect(body).not.toContain('cflu_');
    expect(body).not.toContain('password_hash');
    expect(body).toContain('sessionStorage');
  });
  it('applies the light visual system to every human page', async () => {
    for (const path of ['/admin/login', '/admin/users', '/account', '/forgot-password', '/reset-password']) {
      const body = await (await call(path)).text();
      expect(body).toContain('color-scheme:light');
      expect(body).not.toContain('#0b1114');
    }
  });
  it('renders shared navigation, hides admin links by default, and keeps redirects', async () => {
    const account = await (await call('/account')).text();
    expect(account).toContain('id="nav-admin"');
    expect(account).toContain('hidden');
    expect(account).toContain('id="logout"');
    expect(account).toContain("location.href='/admin/login'");
    const users = await (await call('/admin/users')).text();
    expect(users).toContain("location.href='/account'");
    const reset = await (await call('/reset-password')).text();
    expect(reset).toContain('history.replaceState');
    expect(reset).toContain('autocomplete="new-password"');
  });
  it('keeps visible labels and password-manager autocomplete attributes', async () => {
    const login = await (await call('/admin/login')).text();
    expect(login).toContain('autocomplete="username"');
    expect(login).toContain('autocomplete="current-password"');
    expect(login).toContain('<label for="email">Email</label>');
    expect(login).toContain('<label for="password">Password</label>');
  });
  it('ships a self-contained inline SVG favicon on every human page', async () => {
    for (const path of ['/admin/login', '/admin/users', '/account', '/forgot-password', '/reset-password']) {
      const body = await (await call(path)).text();
      expect(body).toContain('rel="icon"');
      expect(body).toContain('type="image/svg+xml"');
      expect(body).toContain('data:image/svg+xml');
      const href = /href="data:image\/svg\+xml,([^"]+)"/.exec(body)?.[1];
      expect(href).toBeTruthy();
      const svg = decodeURIComponent(href!);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 32 32"');
      expect(svg).not.toContain('<script');
    }
  });
  it('redirects /admin to the users page', async () => {
    const response = await call('/admin');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users');
  });
});
