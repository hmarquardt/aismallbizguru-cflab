// Black-box GET checks only. GET alone does not guarantee a legacy handler is
// side-effect-free: LabBox health can create a MinIO bucket (see COMPATIBILITY).
export function target(value, name) {
  if (!value) throw new Error(`${name} must be explicitly configured`);
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTPS origin (HTTP loopback is allowed locally)`);
  }
  return url.origin;
}

export function collectionPath(service, fixture) {
  if (!fixture || ['app', 'resource'].some(key =>
    typeof fixture[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fixture[key]))) {
    throw new Error('Collection fixtures require safe app and resource identifiers');
  }
  const { app, resource } = fixture;
  if (service === 'labbox') return `/api/${app}/${resource}`;
  if (service === 'cflab') return `/api/apps/${app}/resources/${resource}/records`;
  throw new Error('Unknown compatibility service');
}

export function recordPath(service, fixture) {
  const path = collectionPath(service, fixture);
  if (typeof fixture.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fixture.id)) {
    throw new Error('Record fixtures require a safe id identifier');
  }
  return `${path}/${fixture.id}`;
}

export function legacyHealthEnabled(value) {
  if (value !== undefined && value !== '0' && value !== '1') throw new Error('COMPAT_LABBOX_HEALTH must be 0 or 1');
  // Operator must first confirm STORAGE_HEALTH_ENABLED=false on deployed LabBox.
  return value === '1';
}

export function fixtureToken(fixture, token) {
  if (fixture.anonymous !== undefined && typeof fixture.anonymous !== 'boolean') throw new Error('anonymous must be a boolean');
  if (fixture.anonymous === true) return undefined;
  if (!token) throw new Error('Authenticated probes require a read token for each service');
  return token;
}

export async function getJson(origin, path, token, fetcher = fetch, browserOrigin) {
  const destination = new URL(path, origin);
  if (destination.origin !== origin) throw new Error('Cross-origin probe rejected');
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (browserOrigin) headers.Origin = browserOrigin;
  const response = await fetcher(destination, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel();
    throw new Error(`Expected JSON with HTTP 200; received HTTP ${response.status}`);
  }
  if (browserOrigin && response.headers.get('access-control-allow-origin') !== browserOrigin) {
    await response.body?.cancel();
    throw new Error('Expected explicit matching CORS origin');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error('Probe response exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON response'); }
}

// Complete collection comparison requires preserved IDs and a stable dataset.
// Fail closed on truncation; never report a capped subset as a successful match.
export async function readCollection(service, fixture, read) {
  const path = collectionPath(service, fixture);
  const rows = [];
  const ids = new Set();
  const cursors = new Set();
  let after;
  for (let page = 0; page < 10; page++) {
    const query = service === 'cflab' ? `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}` : '';
    const body = await read(path + query);
    if (!Array.isArray(body?.records)) throw new Error('Expected records array');
    if (rows.length + body.records.length > 1000) throw new Error('Collection exceeds 1000 record probe limit');
    for (const row of body.records) {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)
        || row.app_id !== fixture.app || row.resource !== fixture.resource
        || !row.data || typeof row.data !== 'object' || Array.isArray(row.data) || ids.has(row.id)) {
        throw new Error('Invalid or duplicate collection record');
      }
      ids.add(row.id);
      rows.push({ id: row.id, data: row.data });
    }
    if (service === 'labbox') {
      if (body.total !== rows.length) throw new Error('Legacy total does not match collection');
      return rows.sort((a, b) => a.id.localeCompare(b.id));
    }
    if (body.next_cursor === null) return rows.sort((a, b) => a.id.localeCompare(b.id));
    after = body.next_cursor;
    if (typeof after !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(after)
      || !body.records.length || after !== body.records.at(-1).id || cursors.has(after)) {
      throw new Error('Invalid or repeated collection cursor');
    }
    cursors.add(after);
  }
  throw new Error('Collection exceeds 10 page probe limit');
}

export function healthy(service, value) {
  if (!value || value.status !== 'ok') return false;
  if (service === 'cflab') return value.service === 'cflab';
  // LabBox has no service marker; its known health contract reports DB/storage.
  return service === 'labbox' && value.service !== 'cflab'
    && value.db === 'ok' && typeof value.storage === 'string';
}
