import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQuery, createR2Client, signRequest, uriEncode } from '../../scripts/backup/r2-client.mjs';
import { mirror, mirrorKeyFor, planMirror, verifyMirror } from '../../scripts/backup/r2-mirror.mjs';
import { FORBIDDEN_DESTINATIONS, r2FromEnvironment } from '../../scripts/backup/upload-backups.mjs';
import { sha256Bytes } from '../../scripts/backup/lib.mjs';

// AWS publishes SigV4 test vectors; get-vanilla is the canonical example. Matching
// it exactly is what makes the signing code trustworthy without credentials.
test('SigV4 signing reproduces the published AWS get-vanilla vector', () => {
  const signed = signRequest({
    method: 'GET',
    path: '/',
    query: {},
    headers: { host: 'example.amazonaws.com' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(signed.signedHeaders.join(';'), 'host;x-amz-date');
  assert.equal(signed.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('canonical query and URI encoding follow RFC 3986', () => {
  assert.equal(uriEncode('a b/c', false), 'a%20b/c');
  assert.equal(uriEncode('a b/c'), 'a%20b%2Fc');
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(canonicalQuery({ 'list-type': '2', prefix: 'd1/', 'max-keys': '10' }), 'list-type=2&max-keys=10&prefix=d1%2F');
  assert.equal(canonicalQuery({ b: '2', a: '1' }), 'a=1&b=2');
});

// A fake fetch that behaves like the small slice of the S3 API the client uses.
function fakeR2({ objects = {}, onPut } = {}) {
  const store = { ...objects };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//, ''));
    const method = init.method ?? 'GET';
    calls.push({ method, key });
    if (method === 'GET' && new URL(url).searchParams.has('list-type')) {
      const contents = Object.entries(store).map(([name, value]) => `<Contents><Key>${name}</Key><Size>${value.length}</Size><ETag>&quot;${sha256Bytes(value).slice(0, 8)}&quot;</ETag><LastModified>2026-10-16T00:00:00.000Z</LastModified></Contents>`).join('');
      return new Response(`<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`, { status: 200 });
    }
    if (method === 'HEAD') return new Response(null, { status: key in store ? 200 : 404, headers: { 'content-length': String((store[key] ?? '').length) } });
    if (method === 'GET') return key in store ? new Response(store[key], { status: 200 }) : new Response('missing', { status: 404 });
    if (method === 'PUT') {
      if (onPut) onPut(key, init.body);
      if (key in store) return new Response('exists', { status: 412 });
      store[key] = init.body;
      return new Response(null, { status: 200 });
    }
    return new Response('unsupported', { status: 405 });
  };
  return { fetchImpl, store, calls };
}

function clientFor(fake, bucket = 'cflab-backups') {
  return createR2Client({ accountId: 'acct', bucket, accessKeyId: 'AK', secretAccessKey: 'SK', fetchImpl: fake.fetchImpl });
}

test('the R2 client lists objects, reads bytes, and never overwrites', async () => {
  const fake = fakeR2({ objects: { 'files/a.txt': 'hello' } });
  const client = clientFor(fake);
  const listed = await client.listObjects({ prefix: 'files/' });
  assert.deepEqual(listed.map(entry => entry.key), ['files/a.txt']);
  assert.equal(await client.getObject('files/a.txt'), 'hello');
  assert.equal(await client.headObject('files/missing.txt'), null);
  assert.equal((await client.getObjectBuffer('files/a.txt')).toString(), 'hello');

  const created = await client.putObject('files/b.txt', 'world');
  assert.equal(created.size, 5);
  await assert.rejects(client.putObject('files/b.txt', 'different'), /refusing to overwrite an existing backup object/);
  assert.equal(fake.store['files/b.txt'], 'world', 'the first write must survive the refused overwrite');
});

test('the R2 client exposes no delete operation', () => {
  const client = clientFor(fakeR2());
  for (const name of Object.keys(client)) {
    assert.doesNotMatch(name, /delete|remove|purge/i, `the backup client must not expose ${name}`);
  }
});

test('backups cannot be written into a production or legacy bucket', () => {
  for (const bucket of FORBIDDEN_DESTINATIONS) {
    assert.throws(() => r2FromEnvironment({ CFLAB_BACKUP_BUCKET: bucket, CLOUDFLARE_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' }), /refusing to write backups into/);
  }
  assert.throws(() => r2FromEnvironment({}), /missing backup configuration/);
});

test('mirror keys are content-addressed so a deletion cannot propagate', () => {
  assert.equal(mirrorKeyFor('apps/x/photo.jpg', 'abc123'), 'files/abc123/apps/x/photo.jpg');
  const plan = planMirror({
    sourceObjects: [{ key: 'a', sha256: 'h1' }, { key: 'b', sha256: 'h2' }],
    mirroredKeys: [mirrorKeyFor('a', 'h1')],
  });
  assert.deepEqual(plan.toCopy.map(entry => entry.key), ['b']);
  assert.equal(plan.alreadyMirrored, 1);
});

test('mirroring copies only new content and writes a manifest', async () => {
  const source = fakeR2({ objects: { 'a.txt': 'one', 'b.txt': 'two' } });
  const destination = fakeR2({ objects: { [mirrorKeyFor('a.txt', sha256Bytes('one'))]: 'one' } });
  const result = await mirror({
    source: clientFor(source, 'cflab-files'), destination: clientFor(destination),
    apply: true, log: () => {}, stamp: '20261016T040000Z',
  });

  assert.equal(result.applied, 1, 'only the object missing from the mirror is copied');
  assert.equal(String(destination.store[mirrorKeyFor('b.txt', sha256Bytes('two'))]), 'two');
  const copied = result.manifest.entries.find(entry => entry.key === 'b.txt');
  assert.equal(copied.sha256, sha256Bytes('two'));
  // The already-present object is recognised by content, not by key, and skipped.
  const skipped = result.manifest.entries.find(entry => entry.key === 'a.txt');
  assert.equal(skipped.skipped, 'already mirrored');
  assert.ok(result.manifestKey.startsWith('files/manifests/'));
  // Nothing was deleted from either side.
  assert.deepEqual(Object.keys(source.store).sort(), ['a.txt', 'b.txt']);
});

test('mirror verification detects corrupted or missing mirror objects', async () => {
  const entryKey = mirrorKeyFor('a.txt', sha256Bytes('one'));
  const manifest = { entries: [{ key: 'a.txt', mirrorKey: entryKey, sha256: sha256Bytes('one'), bytes: 3 }] };
  assert.equal((await verifyMirror({ destination: clientFor(fakeR2({ objects: { [entryKey]: 'one' } })), manifest, log: () => {} })).ok, true);

  const corrupted = await verifyMirror({ destination: clientFor(fakeR2({ objects: { [entryKey]: 'tampered' } })), manifest, log: () => {} });
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.problems[0], /hashes to/);

  const missing = await verifyMirror({ destination: clientFor(fakeR2()), manifest, log: () => {} });
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /missing from the mirror/);
});
