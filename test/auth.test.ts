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
const sentMail: { from: unknown; to: unknown; subject: string; text: string; html?: string }[] = [];
const testEnv = {
  ...bindings,
  DEV_ADMIN_TOKEN: adminSecret,
  AUTH_FROM_EMAIL: 'noreply@mail.aismallbizguru.com',
  AUTH_FROM_NAME: 'CFLab',
  AUTH_PUBLIC_BASE_URL: 'https://cflab.example',
  AUTH_SESSION_TTL_SECONDS: '604800',
  AUTH_RESET_TTL_SECONDS: '1800',
  AUTH_INVITE_TTL_SECONDS: '604800',
  EMAIL: {
    send: async (message: { from: unknown; to: unknown; subject: string; text?: string; html?: string }) => {
      sentMail.push({ ...message, text: message.text ?? '' });
      return { messageId: '<test@cflab.example>' };
    },
  },
  RL_LOGIN: { limit: async () => ({ success: true }) },
  RL_RECOVERY: { limit: async () => ({ success: true }) },
  RL_RESET: { limit: async () => ({ success: true }) },
  RL_INVITE: { limit: async () => ({ success: true }) },
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
  it('creating a user emails a single-use invitation that sets the first password', async () => {
    const created = await admin('/users', 'POST', { email: 'newbie@example.com' });
    expect(created.status).toBe(201);
    const user = await created.json<{ id: string; has_password: boolean; email: string; invite: { status: string } }>();
    expect(user.has_password).toBe(false);
    expect(user.invite.status).toBe('pending');
    // Creating the user sends exactly one invitation; no second send is required.
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.to).toBe('newbie@example.com');
    expect(sentMail[0]!.subject).toContain('Set up');
    expect(sentMail[0]!.html).toContain('<html');
    const raw = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    expect((await loginAs('newbie@example.com', password)).response.status).toBe(401);
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password })).status).toBe(200);
    expect((await loginAs('newbie@example.com', password)).response.status).toBe(200);
    // Completing setup returns the account to a "password set" state.
    const after = await admin(`/users/${user.id}`);
    expect(await after.json()).toMatchObject({ has_password: true, invite: { status: 'completed', error: null } });
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
    // A resend invalidates earlier links, and the failed delivery invalidates its
    // own token, so no usable token is left behind and the admin can retry.
    const unused = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').bind(user.id).first('n');
    expect(unused).toBe(0);
    const state = await bindings.DB.prepare('SELECT invite_status, invite_error FROM users WHERE id = ?').bind(user.id).first<{ invite_status: string; invite_error: string }>();
    expect(state?.invite_status).toBe('failed');
    expect(state?.invite_error).toBeTruthy();
  });
});

describe('account invitations', () => {
  it('resends an invitation for an existing account without changing role or memberships', async () => {
    // The Heather case: an administrator record already exists and must be
    // invited in place, never recreated and never given a temporary password.
    const userId = await createUser('heather@example.com', null, { is_admin: true });
    await addMembership(userId, 'demo', 'write');
    const resend = await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    expect(resend.status).toBe(200);
    expect(await resend.json()).toMatchObject({ ok: true, purpose: 'invite', invite: { status: 'pending' } });
    expect(sentMail).toHaveLength(1);
    const raw = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    const after = await admin(`/users/${userId}`);
    expect(await after.json()).toMatchObject({ id: userId, is_admin: true, has_password: false, memberships: [{ app_id: 'demo', access: 'write' }] });
    // Completing setup keeps the administrator role and the membership.
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password })).status).toBe(200);
    const signedIn = await loginAs('heather@example.com', password);
    expect(signedIn.response.status).toBe(200);
    expect(signedIn.body.user?.is_admin).toBe(true);
    expect(signedIn.body.memberships).toEqual([{ app_id: 'demo', access: 'write' }]);
  });

  it('invalidates the previous invitation when resending', async () => {
    const userId = await createUser('heather@example.com', null, { is_admin: true });
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const first = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const second = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[1]!.text)![1]!;
    expect(first).not.toBe(second);
    expect((await call('/api/auth/reset-password', 'POST', { token: first, password })).status).toBe(400);
    expect((await call('/api/auth/reset-password', 'POST', { token: second, password })).status).toBe(200);
  });

  it('never reports a created-but-undelivered invitation as sent', async () => {
    const failing = { ...testEnv, EMAIL: { send: async () => { throw new Error('provider down'); } } };
    const created = await local.fetch(new Request('http://localhost/api/admin/users', {
      method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'heather@example.com' }),
    }), failing);
    expect(created.status).toBe(201);
    const user = await created.json<{ id: string; has_password: boolean; invite: { status: string; error: string } }>();
    expect(user.has_password).toBe(false);
    expect(user.invite.status).toBe('failed');
    expect(user.invite.error).toBeTruthy();
    expect(user.invite.error).not.toContain('provider down');
    // The failed delivery did not leave a usable token behind.
    const unused = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').bind(user.id).first('n');
    expect(unused).toBe(0);
  });


  it('keeps invitation and recovery purposes distinct', async () => {
    const userId = await createUser('heather@example.com', null, { is_admin: true });
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const invite = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    // An invitation cannot be replayed once a password exists.
    expect((await call('/api/auth/reset-password', 'POST', { token: invite, password })).status).toBe(200);
    expect((await call('/api/auth/reset-password', 'POST', { token: invite, password: 'another long password here' })).status).toBe(400);
    // Resending for an account that has a password issues a recovery link instead.
    const resend = await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    expect(await resend.json()).toMatchObject({ purpose: 'recovery' });
    expect(/token=(cflr_[0-9a-f]{64})/.test(sentMail[1]!.text)).toBe(true);
    const purposes = await bindings.DB.prepare('SELECT purpose FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at').bind(userId).all<{ purpose: string }>();
    expect(purposes.results.map(row => row.purpose)).toEqual(['invite', 'recovery']);
  });

  it('expires invitations, reports it, and allows a fresh link', async () => {
    const userId = await createUser('heather@example.com', null, { is_admin: true });
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const invite = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    const past = new Date(Date.now() - 1000).toISOString();
    await bindings.DB.batch([
      bindings.DB.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?').bind(past, userId),
      bindings.DB.prepare('UPDATE users SET invite_expires_at = ? WHERE id = ?').bind(past, userId),
    ]);
    expect((await call('/api/auth/reset-password', 'POST', { token: invite, password })).status).toBe(400);
    const listed = await admin(`/users/${userId}`);
    expect(await listed.json()).toMatchObject({ invite: { status: 'expired' } });
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const fresh = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[1]!.text)![1]!;
    expect((await call('/api/auth/reset-password', 'POST', { token: fresh, password })).status).toBe(200);
  });

  it('cannot activate a disabled account or grant access through setup', async () => {
    const userId = await createUser('heather@example.com', null, { active: false });
    // Disabled accounts are never emailed a setup link.
    expect((await admin(`/users/${userId}/send-password-setup`, 'POST', {})).status).toBe(409);
    expect(sentMail).toHaveLength(0);
    // A token that already exists still cannot be redeemed while inactive.
    const raw = 'cfri_' + 'a'.repeat(64);
    await bindings.DB.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, await hashToken(raw), 'invite', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run();
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password })).status).toBe(400);
    const row = await bindings.DB.prepare('SELECT password_hash, is_admin FROM users WHERE id = ?').bind(userId).first<{ password_hash: string | null; is_admin: number }>();
    expect(row?.password_hash).toBeNull();
    expect(row?.is_admin).toBe(0);
  });


  it('consumes an invitation token once under concurrent submissions', async () => {
    const userId = await createUser('heather@example.com', null);
    await admin(`/users/${userId}/send-password-setup`, 'POST', {});
    const invite = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    const [first, second] = await Promise.all([
      call('/api/auth/reset-password', 'POST', { token: invite, password: 'first concurrent password' }),
      call('/api/auth/reset-password', 'POST', { token: invite, password: 'second concurrent password' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const winner = first.status === 200 ? 'first concurrent password' : 'second concurrent password';
    const loser = first.status === 200 ? 'second concurrent password' : 'first concurrent password';
    expect((await loginAs('heather@example.com', winner)).response.status).toBe(200);
    expect((await loginAs('heather@example.com', loser)).response.status).toBe(401);
  });

  it('rate limits invitation resends per account', async () => {
    const userId = await createUser('heather@example.com', null, { is_admin: true });
    const limited = { ...testEnv, RL_INVITE: { limit: async () => ({ success: false }) } };
    const response = await local.fetch(new Request(`http://localhost/api/admin/users/${userId}/send-password-setup`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' }, body: '{}',
    }), limited);
    expect(response.status).toBe(429);
    expect(sentMail).toHaveLength(0);
  });

  it('sends distinct HTML and text emails and stores only token hashes', async () => {
    await createUser('known@example.com', password);
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    await admin('/users', 'POST', { email: 'newbie@example.com' });
    expect(sentMail).toHaveLength(2);
    const [recovery, invite] = sentMail;
    expect(recovery!.subject).toContain('Reset');
    expect(recovery!.text).toContain('token=cflr_');
    expect(recovery!.html).toContain('Choose a new password');
    expect(invite!.subject).toContain('Set up');
    expect(invite!.text).toContain('token=cfri_');
    expect(invite!.html).toContain('Choose your password');
    const stored = await bindings.DB.prepare('SELECT purpose, token_hash FROM password_reset_tokens ORDER BY purpose').all<{ purpose: string; token_hash: string }>();
    expect(stored.results.map(row => row.purpose)).toEqual(['invite', 'recovery']);
    for (const mail of sentMail) {
      expect(mail.text).not.toContain(password);
      const raw = /token=(cf(?:lr|ri)_[0-9a-f]{64})/.exec(mail.text)![1]!;
      expect(stored.results.some(row => row.token_hash === raw)).toBe(false);
    }
  });
});


// Account creation and external email delivery cannot share a database
// transaction, and a single-use setup token is claimed before the credential
// update. These tests pin the observable guarantees of both boundaries.
describe('delivery and claim boundaries', () => {
  it('keeps a created account when email is unavailable and lets an admin invite it later', async () => {
    const unaudited = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');
    // AUTH_FROM_EMAIL empty means mail is unavailable: creation must still succeed.
    const created = await local.fetch(new Request('http://localhost/api/admin/users', {
      method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'heather@example.com', is_admin: true }),
    }), { ...testEnv, AUTH_FROM_EMAIL: '' });
    expect(created.status).toBe(201);
    const user = await created.json<{ id: string; is_admin: boolean; has_password: boolean; invite: { status: string; error: string } }>();
    expect(user.has_password).toBe(false);
    expect(user.is_admin).toBe(true);
    // Presented as a failure, never as a successful invitation.
    expect(user.invite.status).toBe('failed');
    expect(user.invite.error).toBeTruthy();
    // The account really exists and holds the role it was created with.
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(user.id).first('n')).toBe(1);
    expect(Number(unaudited) + 1).toBe(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n'));
    // A later resend reuses the same account and preserves role and memberships.
    await admin(`/users/${user.id}/memberships`, 'POST', { app_id: 'demo', access: 'write' });
    const resend = await admin(`/users/${user.id}/send-password-setup`, 'POST', {});
    expect(resend.status).toBe(200);
    expect(await resend.json()).toMatchObject({ ok: true, purpose: 'invite', invite: { status: 'pending' } });
    const after = await admin(`/users/${user.id}`);
    expect(await after.json()).toMatchObject({ id: user.id, is_admin: true, memberships: [{ app_id: 'demo', access: 'write' }] });
    // The same account (not a replacement) completes setup and keeps its access.
    const raw = /token=(cfri_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password })).status).toBe(200);
    const signedIn = await loginAs('heather@example.com', password);
    expect(signedIn.body.user?.id).toBe(user.id);
    expect(signedIn.body.user?.is_admin).toBe(true);
    expect(signedIn.body.memberships).toEqual([{ app_id: 'demo', access: 'write' }]);
  });

  it('leaves credentials and sessions untouched when a claimed link is never applied, and a fresh link works', async () => {
    const userId = await createUser('known@example.com', password);
    const session = (await loginAs('known@example.com', password)).body.token!;
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    // Simulate an interrupted claim: the token is spent but the credential batch
    // never ran. Nothing else may have changed.
    await bindings.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?')
      .bind(new Date().toISOString(), await hashToken(raw)).run();
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'a brand new long password' })).status).toBe(400);
    const stored = await bindings.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>();
    expect(await verifyPassword(password, stored!.password_hash)).toBe(true);
    expect(await verifyPassword('a brand new long password', stored!.password_hash)).toBe(false);
    // The existing session was not revoked by the failed attempt.
    expect((await call('/api/auth/me', 'GET', undefined, session)).status).toBe(200);
    // Requesting a fresh recovery link works end to end.
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    const fresh = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[1]!.text)![1]!;
    expect(fresh).not.toBe(raw);
    expect((await call('/api/auth/reset-password', 'POST', { token: fresh, password: 'a brand new long password' })).status).toBe(200);
    // Only now are sessions revoked and the new password the only one that works.
    expect((await call('/api/auth/me', 'GET', undefined, session)).status).toBe(401);
    expect((await loginAs('known@example.com', password)).response.status).toBe(401);
    expect((await loginAs('known@example.com', 'a brand new long password')).response.status).toBe(200);
  });

  it('rejects a link whose expiry passes before the claim', async () => {
    await createUser('known@example.com', password);
    await call('/api/auth/forgot-password', 'POST', { email: 'known@example.com' });
    const raw = /token=(cflr_[0-9a-f]{64})/.exec(sentMail[0]!.text)![1]!;
    await bindings.DB.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), await hashToken(raw)).run();
    expect((await call('/api/auth/reset-password', 'POST', { token: raw, password: 'a brand new long password' })).status).toBe(400);
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
  it('offers password recovery from the login page and a fresh link from the reset page', async () => {
    const login = await (await call('/admin/login')).text();
    expect(login).toContain('href="/forgot-password"');
    expect(login).toContain('Forgot password?');
    const reset = await (await call('/reset-password')).text();
    // Expired, invalid, and already-used links explain themselves and offer a retry.
    expect(reset).toContain('href="/forgot-password"');
    expect(reset).toContain('Request a new link');
    expect(reset).toContain('cf(?:lr|ri)_');
    const forgot = await (await call('/forgot-password')).text();
    expect(forgot).toContain('/api/auth/forgot-password');
  });
  it('shows invitation state and resend controls in the admin users page', async () => {
    const users = await (await call('/admin/users')).text();
    expect(users).toContain('inviteBadge');
    expect(users).toContain('Invitation failed');
    expect(users).toContain('Resend invite');
    expect(users).toContain('send-password-setup');
    // A created user must not be reported as invited when delivery failed.
    expect(users).toContain('invitation email was not delivered');
  });
});

// The Wildlife Field Recorder page is served from https://hmarquardt.github.io,
// which is a different origin from CFLab. These tests pin the origin
// registration and the CORS behavior it depends on, and prove an unregistered
// origin is still refused (no wildcard).
describe('wildlife field recorder deployment origin', () => {
  const wfrOrigin = 'https://hmarquardt.github.io';
  // The shared beforeEach truncates apps/app_origins, so re-apply the
  // registration migration here to exercise the migration SQL itself.
  async function applyWildlifeOriginMigration() {
    const migration = bindings.TEST_MIGRATIONS.find(m => m.name === '0009_wildlife_field_recorder_origin.sql');
    expect(migration, 'migration 0009_wildlife_field_recorder_origin.sql must exist').toBeTruthy();
    for (const query of migration!.queries) await bindings.DB.prepare(query).run();
  }

  it('registers exactly the Wildlife Field Recorder browser origin', async () => {
    await applyWildlifeOriginMigration();
    const { results } = await bindings.DB.prepare('SELECT origin FROM app_origins WHERE app_id = ? ORDER BY origin')
      .bind('wildlife-field-recorder').all<{ origin: string }>();
    expect(results.map(row => row.origin)).toEqual([wfrOrigin]);
    const app = await bindings.DB.prepare('SELECT active FROM apps WHERE id = ?')
      .bind('wildlife-field-recorder').first<{ active: number }>();
    expect(app?.active).toBe(1);
  });

  it('is idempotent when the origin row already exists', async () => {
    await applyWildlifeOriginMigration();
    await applyWildlifeOriginMigration();
    const { results } = await bindings.DB.prepare('SELECT origin FROM app_origins WHERE app_id = ?')
      .bind('wildlife-field-recorder').all<{ origin: string }>();
    expect(results).toHaveLength(1);
  });

  it('accepts the registered WFR origin on auth preflight and responses', async () => {
    await applyWildlifeOriginMigration();
    const preflight = await call('/api/auth/login', 'OPTIONS', undefined, null, {
      Origin: wfrOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(wfrOrigin);
    const response = await call('/api/auth/login', 'POST', { email: 'missing@example.com', password }, null, { Origin: wfrOrigin });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(wfrOrigin);
  });

  it('accepts the registered WFR origin on the wildlife-field-recorder app routes', async () => {
    await applyWildlifeOriginMigration();
    const preflight = await call('/api/apps/wildlife-field-recorder/resources/observations/records', 'OPTIONS', undefined, null, {
      Origin: wfrOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(wfrOrigin);
  });

  it('still rejects an unregistered origin without a wildcard', async () => {
    await applyWildlifeOriginMigration();
    const authPreflight = await call('/api/auth/login', 'OPTIONS', undefined, null, {
      Origin: 'https://not-registered.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    });
    expect(authPreflight.status).toBe(403);
    expect(authPreflight.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const appPreflight = await call('/api/apps/wildlife-field-recorder/resources/observations/records', 'OPTIONS', undefined, null, {
      Origin: 'https://not-registered.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    });
    expect(appPreflight.status).toBe(403);
    expect(appPreflight.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});
