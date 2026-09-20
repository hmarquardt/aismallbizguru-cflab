import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { requireScope } from '../auth/tokens';
import { ApiError, fields, id, jsonBody, object, page, slug, string } from '../http';
import { fileOutput, type FileRow } from './files';

interface RecordRow {
  id: string; app_id: string; resource: string; data_json: string; status: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
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
    ? c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?').bind(c.get('app').id, c.req.param('resource'), after, limit + 1)
    : c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND deleted_at IS NULL AND status = ? AND id > ? ORDER BY id LIMIT ?').bind(c.get('app').id, c.req.param('resource'), status, after, limit + 1);
  const { results } = await statement.all<RecordRow>();
  return c.json({ records: results.slice(0, limit).map(output), next_cursor: results.length > limit ? results[limit - 1]!.id : null });
});
records.post('/', requireScope('records:write'), async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['data', 'status', 'id']);
  const data = object(body.data);
  const status = body.status == null ? null : string(body.status, 'status', 64);
  const recordId = body.id === undefined ? crypto.randomUUID() : id(body.id);
  const now = new Date().toISOString();
  const serialized = JSON.stringify(data);
  try {
    const row = await c.env.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .bind(recordId, c.get('app').id, c.req.param('resource'), serialized, status, now, now).first<RecordRow>();
    return c.json(output(row!), 201);
  } catch (error) {
    // Client-supplied ids make retried creates idempotent: an identical retry
    // returns the existing record, a different payload is a real conflict.
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      const existing = await c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND id = ?')
        .bind(c.get('app').id, c.req.param('resource'), recordId).first<RecordRow>();
      const identical = existing && existing.deleted_at === null && existing.status === status
        && JSON.stringify(JSON.parse(existing.data_json)) === serialized;
      if (identical) return c.json(output(existing));
      throw new ApiError(409, 'id_conflict', 'Record id already exists with different content');
    }
    throw error;
  }
});
records.get('/:id', requireScope('records:read'), async c => {
  const row = await c.env.DB.prepare('SELECT * FROM records WHERE app_id = ? AND resource = ? AND id = ? AND deleted_at IS NULL')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).first<RecordRow>();
  if (!row) throw notFound();
  return c.json(output(row));
});
records.get('/:id/files', requireScope('files:read'), async c => {
  const record = await c.env.DB.prepare('SELECT id FROM records WHERE app_id = ? AND resource = ? AND id = ? AND deleted_at IS NULL')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).first<{ id: string }>();
  if (!record) throw notFound();
  const { results } = await c.env.DB.prepare('SELECT * FROM files WHERE app_id = ? AND resource = ? AND record_id = ? ORDER BY created_at, id')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).all<FileRow>();
  return c.json({ files: results.map(fileOutput), total: results.length });
});
records.patch('/:id', requireScope('records:write'), async c => {
  const body = await jsonBody(c.req.raw); fields(body, ['data', 'status']);
  if (!Object.keys(body).length) throw new ApiError(400, 'invalid_input', 'At least one field is required');
  const data = body.data === undefined ? null : JSON.stringify(object(body.data));
  const status = body.status == null ? null : string(body.status, 'status', 64);
  const row = await c.env.DB.prepare('UPDATE records SET data_json = COALESCE(?, data_json), status = CASE WHEN ? THEN ? ELSE status END, updated_at = ? WHERE app_id = ? AND resource = ? AND id = ? AND deleted_at IS NULL RETURNING *')
    .bind(data, Object.hasOwn(body, 'status') ? 1 : 0, status, new Date().toISOString(), c.get('app').id, c.req.param('resource'), c.req.param('id')).first<RecordRow>();
  if (!row) throw notFound();
  return c.json(output(row));
});
records.delete('/:id', requireScope('records:write'), async c => {
  const existing = await c.env.DB.prepare('SELECT id, deleted_at FROM records WHERE app_id = ? AND resource = ? AND id = ?')
    .bind(c.get('app').id, c.req.param('resource'), c.req.param('id')).first<{ id: string; deleted_at: string | null }>();
  if (!existing) throw notFound();
  if (existing.deleted_at === null) {
    await c.env.DB.prepare('UPDATE records SET deleted_at = ? WHERE app_id = ? AND resource = ? AND id = ?')
      .bind(new Date().toISOString(), c.get('app').id, c.req.param('resource'), c.req.param('id')).run();
  }
  return c.body(null, 204);
});
