import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../src/local';
import production from '../src/index';
import type { Bindings } from '../src/types';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const testEnv = { ...bindings, PROXY_ALLOWED_HOSTS: 'api.open-meteo.com' } as unknown as Bindings;
const safariOrigin = 'https://hmarquardt.github.io';
const curatedId = '11111111-1111-4111-8111-111111111111';
const uncuratedId = '22222222-2222-4222-8222-222222222222';
const curatedImageId = '33333333-3333-4333-8333-333333333333';
const curatedAudioId = '44444444-4444-4444-8444-444444444444';
const uncuratedImageId = '55555555-5555-4555-8555-555555555555';

async function call(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers }), testEnv);
}
async function putFile(id: string, objectKey: string, bytes: string, contentType: string) {
  await bindings.FILES.put(objectKey, bytes, { httpMetadata: { contentType } });
  await bindings.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'wildlife-field-recorder', objectKey, `${id}.bin`, contentType, bytes.length, null, new Date().toISOString(), 'observations', id === uncuratedImageId ? uncuratedId : curatedId).run();
}
beforeAll(async () => { await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM safari_public_records'),
    bindings.DB.prepare('DELETE FROM files'),
    bindings.DB.prepare('DELETE FROM records'),
    bindings.DB.prepare('DELETE FROM apps'),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map(object => object.key));
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('wildlife-field-recorder', 'Wildlife Field Recorder', 1, '{}', ?, ?)").bind(now, now),
    bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .bind(curatedId, 'wildlife-field-recorder', 'observations', JSON.stringify({
        localId: 'a', createdAt: 1747424340000, latitude: 39.123456, longitude: -86.987654,
        subjectCommonName: 'Indigo Bunting', subjectScientificName: 'Passerina cyanea', category: 'bird',
        count: 2, summary: 'A pair singing near the edge of the woods.', transcript: 'private voice transcript',
        userNoteText: 'private field note', behavior: 'singing', habitat: 'woodland edge', tags: ['private-tag'],
        weatherRaw: { current: { temperature_2m: 71.6, relative_humidity_2m: 55, wind_speed_10m: 8, pressure_msl: 1012, weather_code: 1 }, current_units: { temperature_2m: '°F', wind_speed_10m: 'mp/h', pressure_msl: 'hPa' } },
        windDirection: 'SW', gpsStatus: 'ok', accuracyMeters: 4, altitude: 120, heading: 33, speed: 0,
        localTripId: 'private-trip', backendTripId: 'private-backend-trip', llmRaw: { secret: true },
      }), now, now),
    bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .bind(uncuratedId, 'wildlife-field-recorder', 'observations', JSON.stringify({
        localId: 'b', createdAt: 1747424340000, latitude: 38.999999, longitude: -87.111111,
        subjectCommonName: 'Private Bat', category: 'mammal', summary: 'uncurated private record',
        transcript: 'uncurated private transcript', weatherRaw: { current: { temperature_2m: 60 } },
      }), now, now),
    bindings.DB.prepare('INSERT INTO safari_public_records (record_id, created_at) VALUES (?, ?)').bind(curatedId, now),
  ]);
  await putFile(curatedImageId, 'apps/wildlife-field-recorder/files/curated-image', 'curated-image-bytes', 'image/jpeg');
  await putFile(curatedAudioId, 'apps/wildlife-field-recorder/files/curated-audio', 'audio-bytes', 'audio/webm');
  await putFile(uncuratedImageId, 'apps/wildlife-field-recorder/files/uncurated-image', 'uncurated-image-bytes', 'image/jpeg');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('public Safari projection', () => {
  it('serves curated observations without authentication and with an allowlisted shape', async () => {
    const response = await call('/api/public/wildlife-safari/observations', { Origin: safariOrigin });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    const body = await response.json<{ observations: Array<Record<string, unknown>>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.observations).toHaveLength(1);
    const observation = body.observations[0]!;
    expect(Object.keys(observation).sort()).toEqual(['category', 'count', 'description', 'id', 'location', 'observed_at', 'photos', 'species', 'weather']);
    expect(observation).toMatchObject({
      id: curatedId,
      species: { common: 'Indigo Bunting', scientific: 'Passerina cyanea' },
      category: 'bird',
      count: 2,
      description: 'A pair singing near the edge of the woods.',
      location: { latitude: 39.1, longitude: -87, approximate: true },
    });
  });
  it('never exposes exact GPS, private notes, raw payloads, or internal keys', async () => {
    const text = await (await call('/api/public/wildlife-safari/observations')).text();
    for (const forbidden of [
      '39.123456', '-86.987654', 'transcript', 'private voice transcript', 'userNoteText', 'private field note',
      'behavior', 'habitat', 'private-tag', 'weatherRaw', 'accuracyMeters', 'altitude', 'heading',
      'gpsStatus', 'llmRaw', 'localTripId', 'backendTripId', 'object_key', '"speed":', 'apps/wildlife-field-recorder/files',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain(uncuratedId);
    expect(text).not.toContain('Private Bat');
    expect(text).not.toContain('uncurated private transcript');
  });
  it('does not provide record lookup by ID or any write route', async () => {
    expect((await call(`/api/public/wildlife-safari/observations/${curatedId}`)).status).toBe(404);
    expect((await call(`/api/public/wildlife-safari/observations/${uncuratedId}`)).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/observations', {}, 'POST')).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/records')).status).toBe(404);
  });
  it('serves only curated image files and never leaks object keys', async () => {
    const image = await call(`/api/public/wildlife-safari/files/${curatedImageId}`, { Origin: safariOrigin });
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(image.headers.get('Cache-Control')).toContain('public');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(image.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    expect(new TextDecoder().decode(await image.arrayBuffer())).toBe('curated-image-bytes');
    expect((await call(`/api/public/wildlife-safari/files/${uncuratedImageId}`)).status).toBe(404);
    expect((await call(`/api/public/wildlife-safari/files/${curatedAudioId}`)).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/files/not-a-uuid')).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/files/apps/wildlife-field-recorder/files/curated-image')).status).toBe(404);
  });
  it('keeps private wildlife endpoints authenticated and writes impossible', async () => {
    const privatePath = '/api/apps/wildlife-field-recorder/resources/observations/records';
    expect((await call(privatePath)).status).toBe(401);
    expect((await call(`${privatePath}/${curatedId}`)).status).toBe(401);
    expect((await call(privatePath, {}, 'POST')).status).toBe(401);
  });
  it('does not emit a wildcard CORS header and rejects unlisted origins', async () => {
    const allowed = await call('/api/public/wildlife-safari/observations', { Origin: safariOrigin });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    const denied = await call('/api/public/wildlife-safari/observations', { Origin: 'https://evil.example' });
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const plain = await call('/api/public/wildlife-safari/observations');
    expect(plain.status).toBe(200);
    expect(plain.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('excludes archived records from the public projection and photo route', async () => {
    await bindings.DB.prepare('UPDATE records SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), curatedId).run();
    expect(await (await call('/api/public/wildlife-safari/observations')).json()).toMatchObject({ total: 0 });
    expect((await call(`/api/public/wildlife-safari/files/${curatedImageId}`)).status).toBe(404);
  });
  it('works through the production entrypoint with no environment bindings beyond DB/FILES', async () => {
    const response = await production.fetch(new Request('https://cflab.aismallbizguru.com/api/public/wildlife-safari/observations'), testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1 });
  });
});
