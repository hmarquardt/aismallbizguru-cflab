import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { ApiError } from '../http';

// Public, presentation-safe projection for Hank & Heather's Wildlife Safari.
// Only records explicitly listed in safari_public_records are exposed, and only
// allowlisted fields are constructed into the response. Raw payloads, exact GPS,
// transcripts, notes, file metadata, and object keys are never returned.
export const SAFARI_ORIGINS = ['https://hmarquardt.github.io'];
export const SAFARI_APP_ID = 'wildlife-field-recorder';
export const SAFARI_RESOURCE = 'observations';
export const SAFARI_LOCATION_DECIMALS = 1;
export const SAFARI_PUBLIC_FILE_PREFIX = '/api/public/wildlife-safari/files/';
const PUBLIC_RECORD_LIMIT = 1000;

interface RecordRow { id: string; data_json: string }
interface FileRow { id: string; record_id: string; content_type: string }

function rounded(value: number): number {
  const factor = 10 ** SAFARI_LOCATION_DECIMALS;
  return Math.round(value * factor) / factor;
}
function projectLocation(data: Record<string, unknown>) {
  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;
  return { latitude: rounded(latitude), longitude: rounded(longitude), approximate: true };
}
function projectWeather(data: Record<string, unknown>) {
  const raw = data.weatherRaw as { current?: Record<string, unknown>; current_units?: Record<string, unknown> } | undefined;
  const current = raw?.current ?? {};
  const units = raw?.current_units ?? {};
  const temperature = Number(current.temperature_2m);
  const temperatureF = Number.isFinite(temperature) && String(units.temperature_2m ?? '').toUpperCase().includes('F') ? temperature : null;
  const temperatureC = Number.isFinite(temperature) && temperatureF === null ? temperature : null;
  const wind = Number(current.wind_speed_10m);
  const windUnit = String(units.wind_speed_10m ?? '').toLowerCase();
  const windSpeedMph = Number.isFinite(wind) ? (windUnit.includes('mph') || windUnit.includes('mp/h') ? wind : Math.round(wind * 0.621371 * 10) / 10) : null;
  const pressure = Number(current.pressure_msl);
  const pressureUnit = String(units.pressure_msl ?? '').toLowerCase();
  const pressureHpa = Number.isFinite(pressure) ? (pressureUnit.includes('inhg') ? Math.round((pressure / 0.02953) * 10) / 10 : pressure) : null;
  const pressureInHg = Number.isFinite(pressure) ? (pressureUnit.includes('inhg') ? pressure : Math.round(pressure * 0.02953 * 100) / 100) : null;
  const humidity = Number(current.relative_humidity_2m);
  const weather = {
    weather_code: current.weather_code ?? null,
    temperature_f: temperatureF,
    temperature_c: temperatureC,
    humidity_percent: Number.isFinite(humidity) ? humidity : null,
    wind_speed_mph: windSpeedMph,
    wind_direction: typeof data.windDirection === 'string' ? data.windDirection : '',
    pressure_hpa: pressureHpa,
    pressure_in_hg: pressureInHg,
  };
  const hasAny = Object.values(weather).some(value => value !== null && value !== '');
  return hasAny ? weather : null;
}
export function projectObservation(record: { id: string; data_json: string }, files: FileRow[], fileBaseUrl: string) {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(record.data_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch { return null; }
  const common = typeof data.subjectCommonName === 'string' ? data.subjectCommonName : '';
  const scientific = typeof data.subjectScientificName === 'string' ? data.subjectScientificName : '';
  const observedAt = typeof data.createdAt === 'number' ? new Date(data.createdAt).toISOString()
    : typeof data.createdAt === 'string' ? data.createdAt : null;
  return {
    id: record.id,
    species: { common: common || scientific || 'Unknown species', scientific },
    category: typeof data.category === 'string' ? data.category : 'unknown',
    observed_at: observedAt,
    count: typeof data.count === 'number' ? data.count : null,
    description: typeof data.summary === 'string' ? data.summary : '',
    weather: projectWeather(data),
    location: projectLocation(data),
    photos: files.filter(file => file.content_type.startsWith('image/')).map(file => ({
      id: file.id,
      url: `${fileBaseUrl}${SAFARI_PUBLIC_FILE_PREFIX}${file.id}`,
      content_type: file.content_type,
    })),
  };
}

export const publicSafari = new Hono<ContextEnv>();
publicSafari.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin !== undefined && (origin === new URL(c.req.url).origin || SAFARI_ORIGINS.includes(origin));
  if (origin && !allowed) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin!);
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin!);
    c.header('Vary', 'Origin');
  }
});

publicSafari.get('/observations', async c => {
  const { results: records } = await c.env.DB.prepare(
    `SELECT r.id, r.data_json FROM safari_public_records s
     JOIN records r ON r.id = s.record_id
     WHERE r.app_id = ? AND r.resource = ?
     ORDER BY r.id LIMIT ?`,
  ).bind(SAFARI_APP_ID, SAFARI_RESOURCE, PUBLIC_RECORD_LIMIT + 1).all<RecordRow>();
  if (records.length > PUBLIC_RECORD_LIMIT) throw new ApiError(503, 'projection_too_large', 'Public projection exceeds its configured bound');
  const ids = records.map(record => record.id);
  const filesByRecord = new Map<string, FileRow[]>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const { results: files } = await c.env.DB.prepare(
      `SELECT id, record_id, content_type FROM files
       WHERE app_id = ? AND record_id IN (${placeholders}) AND content_type LIKE 'image/%'`,
    ).bind(SAFARI_APP_ID, ...ids).all<FileRow>();
    for (const file of files) {
      const list = filesByRecord.get(file.record_id) ?? [];
      list.push(file);
      filesByRecord.set(file.record_id, list);
    }
  }
  const fileBaseUrl = new URL(c.req.url).origin;
  const observations = records.map(record => projectObservation(record, filesByRecord.get(record.id) ?? [], fileBaseUrl)).filter(Boolean);
  return c.json({ observations, total: observations.length, generated_at: new Date().toISOString() });
});

publicSafari.get('/files/:id', async c => {
  const fileId = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) throw new ApiError(404, 'file_not_found', 'File not found');
  const row = await c.env.DB.prepare(
    `SELECT f.object_key, f.content_type FROM files f
     JOIN safari_public_records s ON s.record_id = f.record_id
     WHERE f.id = ? AND f.app_id = ? AND f.content_type LIKE 'image/%'`,
  ).bind(fileId, SAFARI_APP_ID).first<{ object_key: string; content_type: string }>();
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
  if (origin && (origin === new URL(c.req.url).origin || SAFARI_ORIGINS.includes(origin))) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(object.body, { headers });
});
