import { Hono } from 'hono';
import type { AppRow, ContextEnv } from '../types';
import { ApiError, boolean, fields, id, invalid, jsonBody, object, slug, string, strings } from '../http';
import { hashToken, newToken, scopes } from '../auth/tokens';
import { sourceInput } from '../proxy/policy';
import { adminUsers } from './admin-users';

export function appOutput(row: AppRow) {
  const { config_json, ...rest } = row;
  return { ...rest, active: !!row.active, config: JSON.parse(config_json) as Record<string, unknown> };
}
function origins(value: unknown): string[] {
  return strings(value).map(raw => {
    let url: URL;
    try { url = new URL(raw); } catch { invalid('Invalid origin'); }
    if (url.origin !== raw || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('Use exact HTTP(S) origins without paths');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) invalid('Nonlocal origins require HTTPS');
    return raw;
  });
}
export const admin = new Hono<ContextEnv>();
admin.route('/users', adminUsers);
admin.get('/apps', async c => {
  const after = c.req.query('after') ?? '';
  if (after) slug(after);
  const { results } = await c.env.DB.prepare('SELECT * FROM apps WHERE id > ? ORDER BY id LIMIT 101').bind(after).all<AppRow>();
  return c.json({ apps: results.slice(0, 100).map(appOutput), next_cursor: results.length > 100 ? results[99]!.id : null });
});
admin.post('/apps', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['id', 'name', 'active', 'origins', 'config']);
  const appId = slug(body.id); const name = string(body.name, 'name');
  const active = boolean(body.active ?? true); const allowed = origins(body.origins ?? []);
  const config = object(body.config ?? {}); const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(appId, name, active ? 1 : 0, JSON.stringify(config), now, now),
      ...allowed.map(origin => c.env.DB.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?, ?)').bind(appId, origin)),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: apps.id')) throw new ApiError(409, 'app_exists', 'App already exists');
    throw error;
  }
  return c.json({ id: appId, name, active, config, origins: allowed, created_at: now, updated_at: now }, 201);
});
admin.use('/apps/:app/*', async (c, next) => {
  const app = await c.env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(slug(c.req.param('app'))).first<AppRow>();
  if (!app) throw new ApiError(404, 'app_not_found', 'App not found');
  c.set('app', app); await next();
});
admin.get('/apps/:app', async c => {
  const { results } = await c.env.DB.prepare('SELECT origin FROM app_origins WHERE app_id = ? ORDER BY origin').bind(c.get('app').id).all<{ origin: string }>();
  return c.json({ ...appOutput(c.get('app')), origins: results.map(r => r.origin) });
});
admin.patch('/apps/:app', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['name', 'active', 'origins', 'config']);
  if (!Object.keys(body).length) invalid('At least one field is required');
  const app = c.get('app');
  const name = body.name === undefined ? app.name : string(body.name, 'name');
  const active = body.active === undefined ? app.active : Number(boolean(body.active));
  const config = body.config === undefined ? app.config_json : JSON.stringify(object(body.config));
  const statements = [c.env.DB.prepare('UPDATE apps SET name = ?, active = ?, config_json = ?, updated_at = ? WHERE id = ?').bind(name, active, config, new Date().toISOString(), app.id)];
  if (body.origins !== undefined) {
    const allowed = origins(body.origins);
    statements.push(c.env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?').bind(app.id));
    statements.push(...allowed.map(origin => c.env.DB.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?, ?)').bind(app.id, origin)));
  }
  await c.env.DB.batch(statements);
  return c.json({ updated: true });
});
admin.post('/apps/:app/tokens', async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['name', 'scopes']);
  const name = string(body.name, 'name'); const permissions = scopes(body.scopes);
  const token = newToken(); const tokenId = crypto.randomUUID(); const now = new Date().toISOString();
  await c.env.DB.prepare('INSERT INTO api_tokens (id, app_id, name, token_hash, prefix, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(tokenId, c.get('app').id, name, await hashToken(token), token.slice(0, 12), JSON.stringify(permissions), now).run();
  return c.json({ id: tokenId, name, prefix: token.slice(0, 12), scopes: permissions, token, created_at: now }, 201);
});
admin.get('/apps/:app/tokens', async c => {
  const after = c.req.query('after') ?? ''; if (after) id(after);
  const { results } = await c.env.DB.prepare('SELECT id, name, prefix, scopes_json, created_at, revoked_at FROM api_tokens WHERE app_id = ? AND id > ? ORDER BY id LIMIT 101')
    .bind(c.get('app').id, after).all<{ id: string; name: string; prefix: string; scopes_json: string; created_at: string; revoked_at: string | null }>();
  return c.json({ tokens: results.slice(0, 100).map(({ scopes_json, ...r }) => ({ ...r, scopes: JSON.parse(scopes_json) as string[] })), next_cursor: results.length > 100 ? results[99]!.id : null });
});
admin.delete('/apps/:app/tokens/:id', async c => {
  const result = await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE app_id = ? AND id = ?')
    .bind(new Date().toISOString(), c.get('app').id, id(c.req.param('id'))).run();
  if (!result.meta.changes) throw new ApiError(404, 'token_not_found', 'Token not found');
  return c.body(null, 204);
});
admin.put('/apps/:app/proxy-sources/:source', async c => {
  const source = slug(c.req.param('source'));
  const input = sourceInput(await jsonBody(c.req.raw), c.env.PROXY_ALLOWED_HOSTS);
  const now = new Date().toISOString();
  await c.env.DB.prepare('INSERT INTO proxy_sources (app_id, slug, active, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, slug) DO UPDATE SET active = excluded.active, config_json = excluded.config_json, updated_at = excluded.updated_at')
    .bind(c.get('app').id, source, Number(input.active), JSON.stringify(input.config), now, now).run();
  return c.json({ slug: source, ...input });
});
admin.get('/apps/:app/proxy-sources', async c => {
  const after = c.req.query('after') ?? ''; if (after) slug(after);
  const { results } = await c.env.DB.prepare('SELECT slug, active, config_json, created_at, updated_at FROM proxy_sources WHERE app_id = ? AND slug > ? ORDER BY slug LIMIT 101')
    .bind(c.get('app').id, after).all<{ slug: string; active: number; config_json: string; created_at: string; updated_at: string }>();
  return c.json({ sources: results.slice(0, 100).map(({ config_json, ...r }) => ({ ...r, active: !!r.active, config: JSON.parse(config_json) as unknown })), next_cursor: results.length > 100 ? results[99]!.slug : null });
});
