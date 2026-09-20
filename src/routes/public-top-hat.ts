import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { ApiError } from '../http';

// Top Hat Ferals is intentionally public (legacy default_read: public). This projection is
// scoped to that one app and its image files only; no other app data is reachable.
export const TOP_HAT_APP_ID = 'top-hat-ferals';
export const TOP_HAT_RESOURCES = ['cats', 'sightings', 'interactions'] as const;
export const TOP_HAT_ORIGINS = ['https://tophatferals.com', 'https://www.tophatferals.com', 'https://hmarquardt.github.io'];
const PUBLIC_FILE_PREFIX = '/api/public/top-hat-ferals/files/';

interface RecordRow { id: string; resource: string; data_json: string; created_at: string; updated_at: string }
interface FileRow { id: string; record_id: string; content_type: string }

export const publicTopHat = new Hono<ContextEnv>();
publicTopHat.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin !== undefined && (origin === new URL(c.req.url).origin || TOP_HAT_ORIGINS.includes(origin));
  if (origin && !allowed) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin!);
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
  if (allowed) c.header('Access-Control-Allow-Origin', origin!);
});

publicTopHat.get('/:resource', async c => {
  const resource = c.req.param('resource');
  if (!(TOP_HAT_RESOURCES as readonly string[]).includes(resource)) throw new ApiError(404, 'not_found', 'Route not found');
  const { results: records } = await c.env.DB.prepare(
    'SELECT id, resource, data_json, created_at, updated_at FROM records WHERE app_id = ? AND resource = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1001',
  ).bind(TOP_HAT_APP_ID, resource).all<RecordRow>();
  if (records.length > 1000) throw new ApiError(503, 'projection_too_large', 'Public projection exceeds its configured bound');
  const ids = records.map(record => record.id);
  const photosByRecord = new Map<string, FileRow[]>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const { results: files } = await c.env.DB.prepare(
      `SELECT id, record_id, content_type FROM files WHERE app_id = ? AND record_id IN (${placeholders}) AND content_type LIKE 'image/%' ORDER BY created_at DESC, id DESC`,
    ).bind(TOP_HAT_APP_ID, ...ids).all<FileRow>();
    for (const file of files) {
      const list = photosByRecord.get(file.record_id) ?? [];
      list.push(file);
      photosByRecord.set(file.record_id, list);
    }
  }
  const baseUrl = new URL(c.req.url).origin;
  const output = records.map(record => {
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(record.data_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch { data = {}; }
    return {
      id: record.id,
      resource: record.resource,
      data,
      created_at: record.created_at,
      updated_at: record.updated_at,
      photos: (photosByRecord.get(record.id) ?? []).map(file => ({
        id: file.id,
        url: `${baseUrl}${PUBLIC_FILE_PREFIX}${file.id}`,
        content_type: file.content_type,
      })),
    };
  });
  return c.json({ records: output, total: output.length });
});

publicTopHat.get('/files/:id', async c => {
  const fileId = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) throw new ApiError(404, 'file_not_found', 'File not found');
  const row = await c.env.DB.prepare(
    `SELECT f.object_key, f.content_type FROM files f
     JOIN records r ON r.id = f.record_id AND r.app_id = f.app_id
     WHERE f.id = ? AND f.app_id = ? AND f.content_type LIKE 'image/%' AND r.deleted_at IS NULL`,
  ).bind(fileId, TOP_HAT_APP_ID).first<{ object_key: string; content_type: string }>();
  if (!row) throw new ApiError(404, 'file_not_found', 'File not found');
  const object = await c.env.FILES.get(row.object_key);
  if (!object) throw new ApiError(503, 'file_unavailable', 'File content unavailable');
  const origin = c.req.header('Origin');
  const headers: Record<string, string> = {
    'Content-Type': row.content_type,
    'Content-Length': String(object.size),
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ETag: object.httpEtag,
  };
  if (origin && (origin === new URL(c.req.url).origin || TOP_HAT_ORIGINS.includes(origin))) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(object.body, { headers });
});
