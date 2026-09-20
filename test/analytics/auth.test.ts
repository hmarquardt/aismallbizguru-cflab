import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JUNKDRAWER, bindings, call, migrate, resetData, seedHuman, seedMembership, testEnv, userIdForToken } from './helpers';
import { HumanAuthService } from '../../src/auth/service';

beforeAll(migrate);
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetData();
});

function authed(path: string, token: string, init: RequestInit = {}) {
  return call(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
}

describe('CFLab session validation and site roles', () => {
  it('rejects missing and invalid bearer sessions', async () => {
    expect((await call('/api/sites')).status).toBe(401);
    expect((await authed('/api/sites', 'cflu_' + '0'.repeat(64))).status).toBe(401);
    expect((await call('/api/sites', { headers: { Authorization: 'Bearer not-a-token' } })).status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const token = await seedHuman('expired@example.com', false);
    await bindings.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await authed('/api/sites', token)).status).toBe(401);
  });

  it('fails closed when the CFLab service binding is unavailable', async () => {
    const token = await seedHuman('binding@example.com', true);
    const environment = testEnv({ CFLAB: undefined });
    expect((await authed('/api/sites', token, {})).status).toBe(200);
    expect((await call('/api/sites', { headers: { Authorization: `Bearer ${token}` } }, environment)).status).toBe(503);
  });

  it('lets a global CFLab admin manage every site', async () => {
    const token = await seedHuman('admin@example.com', true);
    const response = await authed('/api/sites', token);
    expect(response.status).toBe(200);
    const body = await response.json<{ sites: Array<{ public_id: string; role: string }> }>();
    expect(body.sites).toHaveLength(2);
    expect(body.sites.every(site => site.role === 'owner')).toBe(true);
  });

  it('lists only member sites for non-admins and denies non-members', async () => {
    const token = await seedHuman('member@example.com', false);
    expect((await (await authed('/api/sites', token)).json<{ sites: unknown[] }>()).sites).toHaveLength(0);
    expect((await authed(`/api/sites/${JUNKDRAWER}`, token)).status).toBe(403);
  });

  it('enforces owner, editor, and viewer roles', async () => {    const ownerToken = await seedHuman('owner@example.com', false);
    const editorToken = await seedHuman('editor@example.com', false);
    const viewerToken = await seedHuman('viewer@example.com', false);
    await seedMembership(1, await userIdForToken(ownerToken), 'owner');
    await seedMembership(1, await userIdForToken(editorToken), 'editor');
    await seedMembership(1, await userIdForToken(viewerToken), 'viewer');
    const base = `/api/sites/${JUNKDRAWER}`;

    expect((await authed(`${base}/summary`, viewerToken)).status).toBe(200);
    expect((await authed(`${base}/summary`, editorToken)).status).toBe(200);
    expect((await authed(`${base}/summary`, ownerToken)).status).toBe(200);

    expect((await authed(`${base}/snippet`, viewerToken)).status).toBe(403);
    expect((await authed(`${base}/snippet`, editorToken)).status).toBe(200);
    expect((await authed(`${base}/snippet`, ownerToken)).status).toBe(200);

    const patch = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) };
    expect((await authed(base, editorToken, patch)).status).toBe(403);
    expect((await authed(base, viewerToken, patch)).status).toBe(403);
    expect((await authed(base, ownerToken, patch)).status).toBe(200);

    const domain = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'extra.example.com' }) };
    expect((await authed(`${base}/domains`, editorToken, domain)).status).toBe(403);
    expect((await authed(`${base}/domains`, ownerToken, domain)).status).toBe(201);
  });
});

describe('CFLab HumanAuthService RPC surface', () => {
  it('returns only userId and isAdmin and rejects invalid tokens', async () => {
    const token = await seedHuman('rpc@example.com', true);
    const service = new HumanAuthService({} as ExecutionContext, bindings);
    expect(await service.verifyHumanSession(token)).toEqual({ userId: await userIdForToken(token), isAdmin: true });
    expect(await service.verifyHumanSession('cflu_' + '0'.repeat(64))).toBeNull();
    expect(await service.verifyHumanSession('not-a-token')).toBeNull();
  });
});
