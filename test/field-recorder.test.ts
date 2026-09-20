import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../src/local';
import type { Bindings } from '../src/types';
import { hashPassword } from '../src/auth/passwords';

const adminSecret = 'local-test-only-secret-with-32-characters';
const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const testEnv = { ...bindings, DEV_ADMIN_TOKEN: adminSecret } as unknown as Bindings & { DEV_ADMIN_TOKEN: string };
const password = 'correct horse battery staple';
const recordId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';

async function call(path: string, method = 'GET', body?: unknown, bearer?: string | null, headers: Record<string, string> = {}, raw?: BodyInit) {
  const h = new Headers(headers);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), testEnv);
}
const admin = (path: string, method = 'GET', body?: unknown) => call(`/api/admin${path}`, method, body, adminSecret);
async function createUser(email: string, options: { is_admin?: boolean; membership?: 'read' | 'write' } = {}) {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare('INSERT INTO users (id, email, password_hash, active, is_admin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .bind(userId, email, await hashPassword(password), options.is_admin ? 1 : 0, now, now).run();
  if (options.membership) {
    await bindings.DB.prepare('INSERT INTO project_memberships (user_id, app_id, access, created_at) VALUES (?, ?, ?, ?)')
      .bind(userId, 'wildlife-field-recorder', options.membership, now).run();
  }
  return userId;
}
async function login(email: string): Promise<string> {
  const response = await call('/api/auth/login', 'POST', { email, password });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}
beforeAll(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM password_reset_tokens'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM project_memberships'),
    bindings.DB.prepare('DELETE FROM users'),
    bindings.DB.prepare('DELETE FROM files'),
    bindings.DB.prepare('DELETE FROM records'),
    bindings.DB.prepare('DELETE FROM apps'),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map(object => object.key));
  expect((await admin('/apps', 'POST', { id: 'wildlife-field-recorder', name: 'Wildlife Field Recorder', origins: ['https://hmarquardt.github.io'] })).status).toBe(201);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Field Recorder backend support', () => {
  it('soft-deletes records, keeps the row recoverable, and is idempotent', async () => {
    await createUser('writer@example.com', { membership: 'write' });
    const writer = await login('writer@example.com');
    const base = '/api/apps/wildlife-field-recorder/resources/observations/records';
    const created = await call(base, 'POST', { data: { localId: 'obs-1', latitude: 38.5, longitude: -87.5 }, id: recordId }, writer);
    expect(created.status).toBe(201);
    expect((await call(base, 'GET', undefined, writer)).json()).resolves.toMatchObject({ records: [{ id: recordId }] });
    expect((await call(`${base}/${recordId}`, 'DELETE', undefined, writer)).status).toBe(204);
    expect((await call(`${base}/${recordId}`, 'GET', undefined, writer)).status).toBe(404);
    expect((await call(`${base}/${recordId}`, 'PATCH', { data: { changed: true } }, writer)).status).toBe(404);
    expect((await call(base, 'GET', undefined, writer)).json()).resolves.toMatchObject({ records: [] });
    expect((await call(`${base}/${recordId}`, 'DELETE', undefined, writer)).status).toBe(204);
    const row = await bindings.DB.prepare('SELECT deleted_at FROM records WHERE id = ?').bind(recordId).first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeTruthy();
  });
  it('makes client-supplied create ids idempotent and rejects real conflicts', async () => {
    await createUser('writer@example.com', { membership: 'write' });
    const writer = await login('writer@example.com');
    const base = '/api/apps/wildlife-field-recorder/resources/observations/records';
    const first = await call(base, 'POST', { data: { localId: 'obs-2' }, id: recordId }, writer);
    expect(first.status).toBe(201);
    const retry = await call(base, 'POST', { data: { localId: 'obs-2' }, id: recordId }, writer);
    expect(retry.status).toBe(200);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE id = ?').bind(recordId).first('n')).toBe(1);
    expect((await call(base, 'POST', { data: { localId: 'different' }, id: recordId }, writer)).status).toBe(409);
    expect((await call(base, 'POST', { data: { localId: 'obs-3' }, id: 'not-a-uuid' }, writer)).status).toBe(400);
  });
  it('uploads record-linked files idempotently and lists them for the record', async () => {
    await createUser('writer@example.com', { membership: 'write' });
    const writer = await login('writer@example.com');
    const records = '/api/apps/wildlife-field-recorder/resources/observations/records';
    const files = '/api/apps/wildlife-field-recorder/files';
    expect((await call(records, 'POST', { data: { localId: 'obs-4' }, id: recordId }, writer)).status).toBe(201);
    const upload = () => call(files, 'POST', undefined, writer, {
      'Content-Type': 'image/jpeg', 'X-Filename': 'photo.jpg', 'X-File-Id': fileId,
      'X-Record-Id': recordId, 'X-Resource': 'observations',
    }, new Uint8Array([1, 2, 3, 4]));
    const first = await upload();
    expect(first.status).toBe(201);
    const body = await first.json<{ id: string; download_url: string; record_id: string; resource: string }>();
    expect(body).toMatchObject({ id: fileId, record_id: recordId, resource: 'observations' });
    expect(body.download_url).toBe(`/api/apps/wildlife-field-recorder/files/${fileId}/content`);
    const retry = await upload();
    expect(retry.status).toBe(200);
    expect((await retry.json<{ id: string }>()).id).toBe(fileId);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').bind(fileId).first('n')).toBe(1);
    expect((await bindings.FILES.list()).objects).toHaveLength(1);
    const conflict = await call(files, 'POST', undefined, writer, {
      'Content-Type': 'image/jpeg', 'X-Filename': 'photo.jpg', 'X-File-Id': fileId,
      'X-Record-Id': recordId, 'X-Resource': 'observations',
    }, new Uint8Array([9, 9, 9, 9]));
    expect(conflict.status).toBe(409);
    const listing = await call(`${records}/${recordId}/files`, 'GET', undefined, writer);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ total: 1, files: [{ id: fileId, resource: 'observations', record_id: recordId }] });
    const missingRecord = await call(files, 'POST', undefined, writer, {
      'Content-Type': 'image/jpeg', 'X-Filename': 'photo.jpg',
      'X-Record-Id': '33333333-3333-4333-8333-333333333333', 'X-Resource': 'observations',
    }, new Uint8Array([5]));
    expect(missingRecord.status).toBe(404);
    expect((await call(files, 'POST', undefined, writer, { 'Content-Type': 'image/jpeg', 'X-Record-Id': recordId }, new Uint8Array([5]))).status).toBe(400);
    const content = await call(body.download_url, 'GET', undefined, writer);
    expect(content.status).toBe(200);
    expect(new TextDecoder().decode(await content.arrayBuffer())).toBe('\u0001\u0002\u0003\u0004');
    expect((await call(`${records}/${recordId}`, 'DELETE', undefined, writer)).status).toBe(204);
    expect((await call(`${records}/${recordId}/files`, 'GET', undefined, writer)).status).toBe(404);
  });
  it('allows the Field Recorder upload headers through CORS preflight', async () => {
    const writer = await login('writer@example.com').catch(() => null);
    void writer;
    await createUser('writer@example.com', { membership: 'write' });
    const response = await call('/api/apps/wildlife-field-recorder/files', 'OPTIONS', undefined, null, {
      Origin: 'https://hmarquardt.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, x-filename, x-file-id, x-record-id, x-resource',
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://hmarquardt.github.io');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-file-id');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-record-id');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-resource');
  });
  it('enforces write membership for recorder mutations', async () => {
    const records = '/api/apps/wildlife-field-recorder/resources/observations/records';
    await createUser('reader@example.com', { membership: 'read' });
    await createUser('outsider@example.com');
    const reader = await login('reader@example.com');
    const outsider = await login('outsider@example.com');
    expect((await call(records, 'GET', undefined, reader)).status).toBe(200);
    expect((await call(records, 'POST', { data: { localId: 'read-denied' } }, reader)).status).toBe(403);
    expect((await call(records, 'GET', undefined, outsider)).status).toBe(403);
    expect((await call(records, 'POST', { data: { localId: 'outsider-denied' } }, outsider)).status).toBe(403);
    expect((await call(records, 'GET')).status).toBe(401);
  });
});
