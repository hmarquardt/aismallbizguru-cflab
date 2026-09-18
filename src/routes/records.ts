import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { requireScope } from '../auth/tokens';
import { ApiError, fields, id, jsonBody, object, page, slug, string } from '../http';

interface RecordRow {
  id: string; app_id: string; resource: string; data_json: string; status: string | null;
  created_at: string; updated_at: string;
}
function output(row: RecordRow) {
  const { data_json, ...rest } = row;
  return { ...rest, data: JSON.parse(data_json) as Record<string, unknown> };
}
const notFound = () => new ApiError(404, 'record_not_found', 'Record not found');
export const records = new Hono<ContextEnv>();
records.use('*', async (c, next) => { slug(c.req.param('resource')); if (c.req.param('id')) id(c.req.param('id')); await next(); });
records.get('/', requireScope('records:read'), async c => {
  const { limit, after, query } = page(c.req.url, ['status']);
  const status = query.get('status');
  if (status !== null) string(status, 'status', 64);
  // Separate fixed statements let both indexed access patterns stay efficient.
  const statement = status === null
    ? c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND id > ? ORDER BY id LIMIT ?').bind(c.get('app').id, c.req.param('resource'), after, limit + 1)
    : c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND status = ? AND id > ? ORDER BY id LIMIT ?').bind(c.get('app').id, c.req.param('resource'), status, after, limit + 1);
  const { results } = await statement.all<RecordRow>();
  return c.json({ records: results.slice(0, limit).map(output), next_cursor: results.length > limit ? results[limit - 1]!.id : null });
});
records.post('/', requireScope('records:write'), async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['data', 'status']);
  const data = object(body.data);
  const status = body.status == null ? null : string(body.status, 'status', 64);
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(crypto.randomUUID(), c.get('app').id, c.req.param('resource'), JSON.stringify(data), status, now, now).first<RecordRow>();
  return c.json(output(row!), 201);
});
records.get('/:id', requireScope('records:read'), async c => {
  const row = await c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND id = ?')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).first<RecordRow>();
  if (!row) throw notFound();
  return c.json(output(row));
});
records.patch('/:id', requireScope('records:write'), async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['data', 'status']);
  if (!Object.keys(body).length) throw new ApiError(400, 'invalid_input', 'At least one field is required');
  const data = body.data === undefined ? null : JSON.stringify(object(body.data));
  const status = body.status == null ? null : string(body.status, 'status', 64);
  const row = await c.env.DB.prepare('UPDATE records SET data_json = COALESCE(?, data_json), status = CASE WHEN ? THEN ? ELSE status END, updated_at = ? WHERE app_id = ? AND resource = ? AND id = ? RETURNING *')
    .bind(data, Object.hasOwn(body, 'status') ? 1 : 0, status, new Date().toISOString(), c.get('app').id, c.req.param('resource'), c.req.param('id')).first<RecordRow>();
  if (!row) throw notFound();
  return c.json(output(row));
});
records.delete('/:id', requireScope('records:write'), async c => {
  const result = await c.env.DB.prepare('DELETE FROM records WHERE app_id = ? AND resource = ? AND id = ?')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).run();
  if (!result.meta.changes) throw notFound();
  return c.body(null, 204);
});
