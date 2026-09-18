import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { collectionPath, fixtureToken, getJson, healthy, legacyHealthEnabled, readCollection, recordPath, target } from './probes.mjs';

test('probe targets are explicit origins with secure credential transport', () => {
  assert.equal(target('https://new.example/', 'new'), 'https://new.example');
  assert.equal(target('http://127.0.0.1:8787', 'local'), 'http://127.0.0.1:8787');
  for (const value of [undefined, 'http://new.example', 'https://u:p@new.example', 'https://new.example/path', 'https://new.example/?token=x']) {
    assert.throws(() => target(value, 'test'));
  }
});
test('fixture paths adapt the known contracts without arbitrary paths', () => {
  const fixture = { app: 'demo', resource: 'notes', id: 'existing-id' };
  assert.equal(recordPath('labbox', fixture), '/api/demo/notes/existing-id');
  assert.equal(recordPath('cflab', fixture), '/api/apps/demo/resources/notes/records/existing-id');
  assert.throws(() => recordPath('cflab', { ...fixture, id: '../admin' }));
  assert.throws(() => recordPath('unknown', fixture));
});
test('probes issue GET only and refuse redirects that could leak credentials', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url.href, 'https://new.example/api/health');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer test-only-token');
    return Response.json({ status: 'ok', service: 'cflab' });
  };
  assert.ok(healthy('cflab', await getJson('https://new.example', '/api/health', 'test-only-token', fetcher)));
  await assert.rejects(getJson('https://new.example', '//other.example', 'test-only-token', fetcher));
  assert.equal(calls, 1);
});
test('health checks distinguish CFLab from the known LabBox response', () => {
  const old = { status: 'ok', db: 'ok', storage: 'unknown' };
  const current = { status: 'ok', service: 'cflab' };
  assert.ok(healthy('labbox', old));
  assert.ok(healthy('cflab', current));
  assert.equal(healthy('cflab', old), false);
  assert.equal(healthy('labbox', current), false);
});
test('probe errors do not include upstream bodies and body reads are bounded', async () => {
  await assert.rejects(getJson('https://new.example', '/api/health', null,
    async () => new Response('sensitive upstream error', { status: 500 })), /^Error: Expected JSON with HTTP 200; received HTTP 500$/);
  await assert.rejects(getJson('https://new.example', '/api/health', null,
    async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })), /exceeds 1 MiB/);
});

test('legacy health needs separate explicit confirmation of side-effect-free configuration', () => {
  assert.equal(legacyHealthEnabled(undefined), false);
  assert.equal(legacyHealthEnabled('0'), false);
  assert.equal(legacyHealthEnabled('1'), true);
  assert.throws(() => legacyHealthEnabled('true'));
});
test('opt-in runner defaults contact only CFLab health and validate configuration before requests', () => {
  const runner = JSON.stringify(new URL('./compat.remote.mjs', import.meta.url).href);
  const script = `
    globalThis.fetch = async (url, init) => {
      if (url.href !== 'https://new.example/api/health' || init.method !== 'GET') {
        throw new Error('Unexpected probe');
      }
      return Response.json({ status: 'ok', service: 'cflab' });
    };
    await import(${runner});
  `;
  const env = { LABBOX_BASE_URL: 'https://old.example', CFLAB_BASE_URL: 'https://new.example' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Confirm legacy storage health is disabled/);
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { console.log('UNEXPECTED_NETWORK'); throw new Error('Unexpected probe'); };
    await import(${runner});
  `], { env: { ...env, COMPAT_LABBOX_HEALTH: 'yes' }, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout, /UNEXPECTED_NETWORK/);
});
test('public-read fixtures explicitly omit credentials even if a token is configured', () => {
  assert.equal(fixtureToken({ anonymous: true }, 'do-not-send'), undefined);
  assert.equal(fixtureToken({}, 'read-only'), 'read-only');
  assert.throws(() => fixtureToken({}, undefined));
  assert.throws(() => fixtureToken({ anonymous: 'true' }, 'read-only'));
});
test('optional browser-origin probes require exact CORS permission', async () => {
  const fetcher = async (_url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Origin, 'https://client.example');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json({}, { headers: { 'Access-Control-Allow-Origin': 'https://client.example' } });
  };
  await getJson('https://new.example', '/api/demo/notes', undefined, fetcher, 'https://client.example');
  for (const allowed of ['', '*', 'https://wrong.example']) {
    await assert.rejects(getJson('https://new.example', '/api/demo/notes', undefined,
      async () => Response.json({}, { headers: { 'Access-Control-Allow-Origin': allowed } }), 'https://client.example'), /matching CORS/);
  }
});

const fixture = { app: 'demo', resource: 'notes' };
const row = id => ({ id, app_id: 'demo', resource: 'notes', data: { title: id } });
test('collection probes follow CFLab cursors and compare independently of legacy ordering', async () => {
  assert.equal(collectionPath('labbox', fixture), '/api/demo/notes');
  assert.throws(() => collectionPath('cflab', { ...fixture, resource: '../admin' }));
  const paths = [];
  const current = await readCollection('cflab', fixture, async path => {
    paths.push(path);
    return paths.length === 1 ? { records: [row('a')], next_cursor: 'a' } : { records: [row('b')], next_cursor: null };
  });
  const old = await readCollection('labbox', fixture, async path => {
    assert.equal(path, '/api/demo/notes');
    return { records: [row('b'), row('a')], total: 2 };
  });
  assert.deepEqual(current, old);
  assert.deepEqual(paths, ['/api/apps/demo/resources/notes/records?limit=100', '/api/apps/demo/resources/notes/records?limit=100&after=a']);
});
test('collections reject malformed cursors, duplicate IDs, wrong ownership and totals', async () => {
  for (const body of [
    { records: [row('a')] },
    { records: [row('a')], next_cursor: '//evil.example' },
    { records: [], next_cursor: 'a' },
    { records: [row('a')], next_cursor: 'b' },
    { records: [row('a'), row('a')], next_cursor: null },
    { records: [{ ...row('a'), app_id: 'other' }], next_cursor: null },
    { records: [{ ...row('a'), data: [] }], next_cursor: null },
  ]) await assert.rejects(readCollection('cflab', fixture, async () => body));
  await assert.rejects(readCollection('cflab', fixture, async () => ({ records: [row('a')], next_cursor: 'a' })), /duplicate/);
  await assert.rejects(readCollection('labbox', fixture, async () => ({ records: [row('a')], total: 2 })), /total/);
});
test('collection safety caps fail instead of reporting truncated success', async () => {
  await assert.rejects(readCollection('labbox', fixture, async () => ({ records: Array.from({ length: 1001 }, (_, i) => row(String(i))), total: 1001 })), /1000 record/);
  let calls = 0;
  await assert.rejects(readCollection('cflab', fixture, async () => {
    calls++;
    return { records: [row(String(calls))], next_cursor: String(calls) };
  }), /10 page/);
  assert.equal(calls, 10);
});
