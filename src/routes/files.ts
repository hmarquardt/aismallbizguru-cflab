import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { requireScope } from '../auth/tokens';
import { ApiError, id, page, readLimited, string } from '../http';

interface FileRow {
  id: string; app_id: string; object_key: string; filename: string;
  content_type: string; size_bytes: number; checksum: string | null; created_at: string;
}
function output(row: FileRow) {
  const { object_key: _key, ...rest } = row;
  return { ...rest, download_url: `/api/apps/${row.app_id}/files/${row.id}/content` };
}
export const files = new Hono<ContextEnv>();
files.use('*', async (c, next) => { if (c.req.param('id')) id(c.req.param('id')); await next(); });
files.post('/', requireScope('files:write'), async c => {
  const filename = string(c.req.header('X-Filename') ?? 'download', 'filename', 200);
  const contentType = c.req.header('Content-Type') ?? 'application/octet-stream';
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType) || contentType.length > 128) {
    throw new ApiError(400, 'invalid_input', 'Expected a MIME type without parameters');
  }
  // Bounded uploads simplify R2 size accounting and rollback. Downloads stream.
  const bytes = await readLimited(c.req.raw.body, 8 * 1024 * 1024);
  const fileId = crypto.randomUUID();
  const objectKey = `apps/${c.get('app').id}/files/${fileId}`;
  const checksumBytes = await crypto.subtle.digest('SHA-256', bytes);
  const checksum = Array.from(new Uint8Array(checksumBytes), b => b.toString(16).padStart(2, '0')).join('');
  const row: FileRow = { id: fileId, app_id: c.get('app').id, object_key: objectKey, filename,
    content_type: contentType, size_bytes: bytes.length, checksum, created_at: new Date().toISOString() };
  await c.env.FILES.put(objectKey, bytes, { httpMetadata: { contentType }, sha256: checksum });
  try {
    await c.env.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.app_id, row.object_key, row.filename, row.content_type, row.size_bytes, row.checksum, row.created_at).run();
  } catch (error) {
    await c.env.FILES.delete(objectKey);
    throw error;
  }
  return c.json(output(row), 201);
});
files.get('/', requireScope('files:read'), async c => {
  const { limit, after } = page(c.req.url);
  const { results } = await c.env.DB.prepare('SELECT * FROM files WHERE app_id = ? AND id > ? ORDER BY id LIMIT ?')
    .bind(c.get('app').id, after, limit + 1).all<FileRow>();
  return c.json({ files: results.slice(0, limit).map(output), next_cursor: results.length > limit ? results[limit - 1]!.id : null });
});
async function find(db: D1Database, appId: string, fileId: string) {
  const row = await db.prepare('SELECT * FROM files WHERE app_id = ? AND id = ?').bind(appId, fileId).first<FileRow>();
  if (!row) throw new ApiError(404, 'file_not_found', 'File not found');
  return row;
}
files.get('/:id', requireScope('files:read'), async c => c.json(output(await find(c.env.DB, c.get('app').id, c.req.param('id')))));
files.get('/:id/content', requireScope('files:read'), async c => {
  const row = await find(c.env.DB, c.get('app').id, c.req.param('id'));
  const object = await c.env.FILES.get(row.object_key);
  if (!object) throw new ApiError(503, 'file_unavailable', 'File content unavailable');
  return new Response(object.body, { headers: {
    'Content-Type': row.content_type,
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    ETag: object.httpEtag,
  } });
});
files.delete('/:id', requireScope('files:write'), async c => {
  const row = await find(c.env.DB, c.get('app').id, c.req.param('id'));
  // R2 first: a failed D1 delete leaves metadata that a retry can remove.
  await c.env.FILES.delete(row.object_key);
  await c.env.DB.prepare('DELETE FROM files WHERE app_id = ? AND id = ?').bind(row.app_id, row.id).run();
  return c.body(null, 204);
});
