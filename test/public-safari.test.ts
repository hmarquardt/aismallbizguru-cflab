import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import local from '../src/local';
import production from '../src/index';
import type { Bindings } from '../src/types';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const testEnv = { ...bindings, PROXY_ALLOWED_HOSTS: 'api.open-meteo.com' } as unknown as Bindings;
const safariOrigin = 'https://hmarquardt.github.io';

const OBS_A_CREATED_AT = 1767225600000; // 2026-01-01T00:00:00Z
const OBS_B_CREATED_AT = 1767312000000; // 2026-01-02T00:00:00Z

// There is no curation allowlist any more: every submitted, non-deleted
// wildlife-field-recorder observation is public.
const obsA = '11111111-1111-4111-8111-111111111111';
const obsB = '22222222-2222-4222-8222-222222222222';
const obsDeleted = '33333333-3333-4333-8333-333333333333';
const tripRec = '44444444-4444-4444-8444-444444444444';
const otherAppObs = '55555555-5555-4555-8555-555555555555';

const imgA = 'a1111111-1111-4111-8111-111111111111';
const audA = 'a2222222-2222-4222-8222-222222222222';
const imgB = 'a3333333-3333-4333-8333-333333333333';
const imgDeleted = 'a4444444-4444-4444-8444-444444444444';
const imgTrip = 'a5555555-5555-4555-8555-555555555555';
const imgOtherApp = 'a6666666-6666-4666-8666-666666666666';

async function call(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return await local.fetch(new Request(`http://localhost${path}`, { method, headers }), testEnv);
}
async function putFile(
  id: string, objectKey: string, bytes: string, contentType: string,
  appId = 'wildlife-field-recorder', resource: string | null = 'observations', recordId: string | null = obsA,
) {
  await bindings.FILES.put(objectKey, bytes, { httpMetadata: { contentType } });
  await bindings.DB.prepare('INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, appId, objectKey, `${id}.bin`, contentType, bytes.length, null, new Date().toISOString(), resource, recordId).run();
}
async function putObservation(
  id: string, data: Record<string, unknown>, appId = 'wildlife-field-recorder', resource = 'observations',
  deletedAt: string | null = null,
) {
  const now = new Date().toISOString();
  await bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
    .bind(id, appId, resource, JSON.stringify(data), now, now, deletedAt).run();
}
async function publicObservations(query = '', headers: Record<string, string> = {}) {
  const response = await call(`/api/public/wildlife-safari/observations${query}`, headers);
  const body = await response.json<{
    observations: Array<Record<string, unknown>>; total: number; returned: number;
    limit: number; offset: number; has_more: boolean; next_offset: number | null;
  }>();
  return { response, body };
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
    bindings.DB.prepare("INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES ('other-app', 'Other App', 1, '{}', ?, ?)").bind(now, now),
  ]);
  // A fully populated, image-bearing observation.
  await putObservation(obsA, {
    localId: 'a', createdAt: OBS_A_CREATED_AT, latitude: 38.36127, longitude: -87.66491,
    subjectCommonName: 'Indigo Bunting', subjectScientificName: 'Passerina cyanea', category: 'bird',
    count: 2, summary: 'A pair singing near the edge of the woods.', transcript: 'private voice transcript',
    userNoteText: 'private field note', behavior: 'singing', habitat: 'woodland edge', tags: ['private-tag'],
    weatherRaw: { current: { temperature_2m: 71.6, relative_humidity_2m: 55, wind_speed_10m: 8, pressure_msl: 1012, weather_code: 1 }, current_units: { temperature_2m: '°F', wind_speed_10m: 'mp/h', pressure_msl: 'hPa' } },
    windDirection: 'SW', gpsStatus: 'ok', accuracyMeters: 4, altitude: 120, heading: 33, speed: 0,
    localTripId: 'private-trip', backendTripId: 'private-backend-trip', llmRaw: { secret: true },
  });
  // A second observation with only a photo. Under the old curation rule this
  // needed an explicit allowlist row; now it is public by definition.
  await putObservation(obsB, {
    localId: 'b', createdAt: OBS_B_CREATED_AT, latitude: 38.38984, longitude: -87.72116,
    subjectCommonName: 'Barred Owl', category: 'bird', summary: 'Calling from the creek bottom.',
    transcript: 'second private transcript', userNoteText: 'second private note',
  });
  // Archived observation: must never be public.
  await putObservation(obsDeleted, {
    localId: 'c', createdAt: OBS_B_CREATED_AT + 1000, latitude: 38.5, longitude: -87.5,
    subjectCommonName: 'Deleted Bat', category: 'mammal', summary: 'archived record',
  }, 'wildlife-field-recorder', 'observations', now);
  // Same app, different resource: must never be public.
  await putObservation(tripRec, {
    localId: 'trip-1', createdAt: OBS_A_CREATED_AT, title: 'Private trip title', summary: 'private trip summary',
  }, 'wildlife-field-recorder', 'trips');
  // Different app entirely: must never be public.
  await putObservation(otherAppObs, {
    localId: 'other-1', createdAt: OBS_A_CREATED_AT, subjectCommonName: 'Other App Beast', category: 'mammal',
  }, 'other-app', 'observations');
  await putFile(imgA, 'apps/wildlife-field-recorder/files/img-a', 'image-a-bytes', 'image/jpeg');
  await putFile(audA, 'apps/wildlife-field-recorder/files/aud-a', 'audio-a-bytes', 'audio/webm');
  await putFile(imgB, 'apps/wildlife-field-recorder/files/img-b', 'image-b-bytes', 'image/png', 'wildlife-field-recorder', 'observations', obsB);
  await putFile(imgDeleted, 'apps/wildlife-field-recorder/files/img-deleted', 'deleted-bytes', 'image/jpeg', 'wildlife-field-recorder', 'observations', obsDeleted);
  await putFile(imgTrip, 'apps/wildlife-field-recorder/files/img-trip', 'trip-bytes', 'image/jpeg', 'wildlife-field-recorder', 'trips', tripRec);
  await putFile(imgOtherApp, 'apps/other-app/files/img-other', 'other-bytes', 'image/jpeg', 'other-app', 'observations', otherAppObs);
});
afterEach(() => { vi.restoreAllMocks(); });


describe('public Safari projection visibility', () => {
  it('serves submitted, non-deleted WFR observations without authentication and with an allowlisted shape', async () => {
    const { response, body } = await publicObservations('', { Origin: safariOrigin });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    expect(body.total).toBe(2);
    expect(body.returned).toBe(2);
    expect(body.observations).toHaveLength(2);
    for (const observation of body.observations) {
      expect(Object.keys(observation).sort()).toEqual(['category', 'count', 'description', 'id', 'location', 'observed_at', 'photos', 'species', 'weather']);
    }
    const bunting = body.observations.find(o => o.id === obsA)!;
    expect(bunting).toMatchObject({
      id: obsA,
      species: { common: 'Indigo Bunting', scientific: 'Passerina cyanea' },
      category: 'bird',
      count: 2,
      description: 'A pair singing near the edge of the woods.',
      location: { latitude: 38.361, longitude: -87.665, approximate: true },
    });
  });

  it('requires no safari_public_records row', async () => {
    const allowance = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM safari_public_records').first<{ n: number }>();
    expect(allowance?.n).toBe(0);
    const { body } = await publicObservations();
    expect(body.total).toBe(2);
    expect(body.observations.map(o => o.id).sort()).toEqual([obsA, obsB].sort());
  });

  it('returns all historical observations already stored in records', async () => {
    const historical = [
      { id: 'bb111111-1111-4111-8111-111111111111', createdAt: OBS_A_CREATED_AT - 3000, species: 'Historical One' },
      { id: 'bb222222-2222-4222-8222-222222222222', createdAt: OBS_A_CREATED_AT - 2000, species: 'Historical Two' },
      { id: 'bb333333-3333-4333-8333-333333333333', createdAt: OBS_A_CREATED_AT - 1000, species: 'Historical Three' },
    ];
    for (const record of historical) {
      await putObservation(record.id, { createdAt: record.createdAt, subjectCommonName: record.species, category: 'bird' });
    }
    const { body } = await publicObservations('?limit=1000');
    expect(body.total).toBe(5);
    const ids = body.observations.map(o => o.id);
    for (const record of historical) expect(ids).toContain(record.id);
  });

  it('publishes a newly inserted observation with no second publication step', async () => {
    const freshId = 'cc111111-1111-4111-8111-111111111111';
    await putObservation(freshId, { createdAt: Date.now(), subjectCommonName: 'Fresh Kestrel', category: 'bird', summary: 'Just submitted.' });
    const { body } = await publicObservations();
    expect(body.observations.map(o => o.id)).toContain(freshId);
    // No allowlist row was created, and none is required.
    const allowance = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM safari_public_records').first<{ n: number }>();
    expect(allowance?.n).toBe(0);
  });

  it('excludes a deleted observation from the projection and the photo route', async () => {
    const { body } = await publicObservations('?limit=1000');
    expect(body.observations.map(o => o.id)).not.toContain(obsDeleted);
    expect(body.total).toBe(2);
    expect((await call(`/api/public/wildlife-safari/files/${imgDeleted}`)).status).toBe(404);
  });

  it('excludes records belonging to another app', async () => {
    const { body } = await publicObservations('?limit=1000');
    expect(body.observations.map(o => o.id)).not.toContain(otherAppObs);
    expect((await call(`/api/public/wildlife-safari/files/${imgOtherApp}`)).status).toBe(404);
  });

  it('excludes other WFR resources such as trips', async () => {
    const { body } = await publicObservations('?limit=1000');
    expect(body.observations.map(o => o.id)).not.toContain(tripRec);
    expect(body.total).toBe(2);
    expect((await call(`/api/public/wildlife-safari/files/${imgTrip}`)).status).toBe(404);
    const text = JSON.stringify(body);
    expect(text).not.toContain('Private trip title');
  });

  it('orders observations by capture time, newest first', async () => {
    const { body } = await publicObservations();
    expect(body.observations.map(o => o.id)).toEqual([obsB, obsA]);
    const timestamps = body.observations.map(o => Date.parse(String(o.observed_at)));
    expect(timestamps[0]).toBeGreaterThan(timestamps[1]!);
  });
});


describe('public Safari privacy boundary', () => {
  it('never exposes exact GPS and keeps the configured approximate precision', async () => {
    const { body } = await publicObservations();
    const bunting = body.observations.find(o => o.id === obsA)!;
    expect(bunting.location).toEqual({ latitude: 38.361, longitude: -87.665, approximate: true });
    const text = JSON.stringify(body);
    for (const exact of ['38.36127', '-87.66491', '38.38984', '-87.72116', 'accuracyMeters', 'altitude', 'heading', 'gpsStatus', '"speed"']) {
      expect(text).not.toContain(exact);
    }
  });

  it('never exposes transcripts, private notes, raw payloads, or internal metadata', async () => {
    const text = await (await call('/api/public/wildlife-safari/observations?limit=1000')).text();
    for (const forbidden of [
      'transcript', 'private voice transcript', 'second private transcript', 'userNoteText', 'private field note',
      'second private note', 'behavior', 'habitat', 'private-tag', 'weatherRaw', 'llmRaw', 'localTripId',
      'backendTripId', 'object_key', 'apps/wildlife-field-recorder/files', 'private-backend-trip',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain('Deleted Bat');
    expect(text).not.toContain('Other App Beast');
  });

  it('projects image files and omits non-image files', async () => {
    const { body } = await publicObservations();
    const bunting = body.observations.find(o => o.id === obsA)!;
    const photos = bunting.photos as Array<Record<string, unknown>>;
    expect(photos).toHaveLength(1);
    expect(photos[0]!.id).toBe(imgA);
    expect(photos[0]!.content_type).toBe('image/jpeg');
    expect(String(photos[0]!.url)).toBe(`http://localhost/api/public/wildlife-safari/files/${imgA}`);
    const owl = body.observations.find(o => o.id === obsB)!;
    expect(owl.photos).toHaveLength(1);
    expect((owl.photos as Array<Record<string, unknown>>)[0]!.id).toBe(imgB);
    // The audio file attached to obsA is never projected as a photo.
    expect(JSON.stringify(body)).not.toContain(audA);
  });

  it('serves only image files attached to non-deleted WFR observations', async () => {
    const image = await call(`/api/public/wildlife-safari/files/${imgA}`, { Origin: safariOrigin });
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(image.headers.get('Cache-Control')).toContain('public');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(image.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    expect(new TextDecoder().decode(await image.arrayBuffer())).toBe('image-a-bytes');
    // Non-image, wrong app, wrong resource, archived record, and malformed IDs.
    expect((await call(`/api/public/wildlife-safari/files/${audA}`)).status).toBe(404);
    expect((await call(`/api/public/wildlife-safari/files/${imgOtherApp}`)).status).toBe(404);
    expect((await call(`/api/public/wildlife-safari/files/${imgTrip}`)).status).toBe(404);
    expect((await call(`/api/public/wildlife-safari/files/${imgDeleted}`)).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/files/not-a-uuid')).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/files/apps/wildlife-field-recorder/files/img-a')).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/files/99999999-9999-4999-8999-999999999999')).status).toBe(404);
    const text = await (await call(`/api/public/wildlife-safari/files/${imgA}`)).text();
    expect(text).not.toContain('object_key');
    expect(text).not.toContain('apps/wildlife-field-recorder');
  });

  it('does not provide record lookup by ID or any write route', async () => {
    expect((await call(`/api/public/wildlife-safari/observations/${obsA}`)).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/observations', {}, 'POST')).status).toBe(404);
    expect((await call('/api/public/wildlife-safari/records')).status).toBe(404);
  });

  it('keeps private wildlife endpoints authenticated and writes impossible', async () => {
    const privatePath = '/api/apps/wildlife-field-recorder/resources/observations/records';
    expect((await call(privatePath)).status).toBe(401);
    expect((await call(`${privatePath}/${obsA}`)).status).toBe(401);
    expect((await call(privatePath, {}, 'POST')).status).toBe(401);
  });
});

describe('public Safari location precision', () => {
  // Realistic southern-Indiana road-cruise fixes. Both round to the same 0.1
  // degree bucket, which is exactly what made the public map collapse sightings
  // onto one point.
  const RAW_A = { latitude: 38.36127, longitude: -87.66491 };
  const RAW_B = { latitude: 38.38984, longitude: -87.72116 };

  function locationOf(body: { observations: Array<Record<string, unknown>> }, id: string) {
    return body.observations.find(o => o.id === id)!.location as { latitude: number; longitude: number; approximate?: boolean };
  }
  function decimals(value: number) {
    return (String(value).split('.')[1] ?? '').length;
  }

  it('rounds stored full-precision coordinates to exactly three decimal places', async () => {
    const { body } = await publicObservations();
    expect(locationOf(body, obsA)).toEqual({ latitude: 38.361, longitude: -87.665, approximate: true });
    expect(locationOf(body, obsB)).toEqual({ latitude: 38.39, longitude: -87.721, approximate: true });
    for (const observation of body.observations) {
      const location = observation.location as { latitude: number; longitude: number; approximate?: boolean } | null;
      if (!location) continue;
      expect(Object.keys(location).sort()).toEqual(['approximate', 'latitude', 'longitude']);
      expect(location.approximate).toBe(true);
      for (const value of [location.latitude, location.longitude]) {
        expect(decimals(value)).toBeLessThanOrEqual(3);
        // Exactly representable at the configured precision, not a truncated string.
        expect(Math.abs(value * 1000 - Math.round(value * 1000))).toBeLessThan(1e-9);
      }
      expect(location.latitude).not.toBe(RAW_A.latitude);
      expect(location.longitude).not.toBe(RAW_A.longitude);
    }
  });

  it('never returns coordinates at raw stored precision', async () => {
    const text = await (await call('/api/public/wildlife-safari/observations?limit=1000')).text();
    for (const raw of [
      String(RAW_A.latitude), String(RAW_A.longitude), String(RAW_B.latitude), String(RAW_B.longitude),
    ]) {
      expect(text).not.toContain(raw);
    }
    const { body } = await publicObservations();
    for (const observation of body.observations) {
      const location = observation.location as { latitude: number; longitude: number } | null;
      if (!location) continue;
      expect(decimals(location.latitude)).toBeLessThanOrEqual(3);
      expect(decimals(location.longitude)).toBeLessThanOrEqual(3);
    }
  });

  it('keeps observations distinct inside the same old 0.1-degree bucket', async () => {
    const { body } = await publicObservations();
    const a = locationOf(body, obsA);
    const b = locationOf(body, obsB);
    // Confirms the fixture is a genuine regression case: at 1 decimal place the
    // old projection put both observations on the same public coordinate.
    expect(Math.round(RAW_A.latitude * 10)).toBe(Math.round(RAW_B.latitude * 10));
    expect(Math.round(RAW_A.longitude * 10)).toBe(Math.round(RAW_B.longitude * 10));
    // At 3 decimals they stay separate.
    expect(a.latitude).not.toBe(b.latitude);
    expect(a.longitude).not.toBe(b.longitude);
    expect(Math.abs(a.latitude - b.latitude)).toBeGreaterThanOrEqual(0.001);
    expect(Math.abs(a.longitude - b.longitude)).toBeGreaterThanOrEqual(0.001);
    const pairs = new Set(body.observations.map(o => {
      const location = o.location as { latitude: number; longitude: number } | null;
      return location ? `${location.latitude},${location.longitude}` : 'none';
    }));
    expect(pairs.size).toBe(2);
  });

  it('keeps approximate: true on every projected location', async () => {
    const { body } = await publicObservations();
    const withLocation = body.observations.filter(o => o.location);
    expect(withLocation.length).toBeGreaterThan(0);
    for (const observation of withLocation) {
      expect((observation.location as { approximate?: boolean }).approximate).toBe(true);
    }
  });
});


describe('public Safari CORS', () => {
  it('does not emit a wildcard CORS header and rejects unlisted origins', async () => {
    const allowed = await call('/api/public/wildlife-safari/observations', { Origin: safariOrigin });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(safariOrigin);
    const denied = await call('/api/public/wildlife-safari/observations', { Origin: 'https://evil.example' });
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const plain = await call('/api/public/wildlife-safari/observations');
    expect(plain.status).toBe(200);
    expect(plain.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const deniedFile = await call(`/api/public/wildlife-safari/files/${imgA}`, { Origin: 'https://evil.example' });
    expect(deniedFile.status).toBe(403);
    expect(deniedFile.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it('works through the production entrypoint with no environment bindings beyond DB/FILES', async () => {
    const response = await production.fetch(new Request('https://cflab.aismallbizguru.com/api/public/wildlife-safari/observations'), testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 2 });
  });
});


describe('public Safari pagination and dataset growth', () => {
  async function insertBulk(count: number) {
    const base = 1700000000000;
    for (let start = 0; start < count; start += 100) {
      const statements = [];
      for (let i = start; i < Math.min(start + 100, count); i++) {
        const id = `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
        statements.push(
          bindings.DB.prepare('INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
            .bind(id, 'wildlife-field-recorder', 'observations', JSON.stringify({ createdAt: base + i, subjectCommonName: `Bulk ${i}`, category: 'bird' }), new Date().toISOString(), new Date().toISOString()),
        );
      }
      await bindings.DB.batch(statements);
    }
  }

  it('paginates deterministically without repeating or dropping records', async () => {
    await insertBulk(25);
    const seen = new Set<string>();
    let offset = 0;
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      const { response, body } = await publicObservations(`?limit=10&offset=${offset}`);
      expect(response.status).toBe(200);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(offset);
      for (const observation of body.observations) seen.add(String(observation.id));
      hasMore = body.has_more;
      if (hasMore) {
        expect(body.next_offset).toBe(offset + body.returned);
        offset = body.next_offset!;
      } else {
        expect(body.next_offset).toBeNull();
      }
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(seen.size).toBe(27); // 25 bulk + obsA + obsB
  });

  it('does not fail once the dataset crosses the old 1000-record ceiling', async () => {
    await insertBulk(1001);
    const { response, body } = await publicObservations('?limit=1000&offset=0');
    expect(response.status).toBe(200);
    expect(body.total).toBe(1003);
    expect(body.returned).toBe(1000);
    expect(body.has_more).toBe(true);
    expect(body.next_offset).toBe(1000);
    const second = await publicObservations('?limit=1000&offset=1000');
    expect(second.response.status).toBe(200);
    expect(second.body.returned).toBe(3);
    expect(second.body.has_more).toBe(false);
    expect(second.body.next_offset).toBeNull();
    const ids = new Set([...body.observations, ...second.body.observations].map(o => String(o.id)));
    expect(ids.size).toBe(1003);
  });

  it('caps the page size and rejects malformed pagination parameters', async () => {
    const tooLarge = await call('/api/public/wildlife-safari/observations?limit=5000');
    expect(tooLarge.status).toBe(400);
    expect((await call('/api/public/wildlife-safari/observations?limit=0')).status).toBe(400);
    expect((await call('/api/public/wildlife-safari/observations?limit=-1')).status).toBe(400);
    expect((await call('/api/public/wildlife-safari/observations?limit=abc')).status).toBe(400);
    expect((await call('/api/public/wildlife-safari/observations?offset=-5')).status).toBe(400);
    expect((await call('/api/public/wildlife-safari/observations?offset=999999999999')).status).toBe(400);
    const max = await call('/api/public/wildlife-safari/observations?limit=1000');
    expect(max.status).toBe(200);
    const fallback = await call('/api/public/wildlife-safari/observations?limit=&offset=');
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ limit: 500, offset: 0 });
  });

  it('returns an empty, well-formed page when there are no observations', async () => {
    await bindings.DB.prepare("DELETE FROM records WHERE app_id = 'wildlife-field-recorder' AND resource = 'observations'").run();
    const { response, body } = await publicObservations();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 0, returned: 0, has_more: false, next_offset: null });
    expect(body.observations).toEqual([]);
  });
});

