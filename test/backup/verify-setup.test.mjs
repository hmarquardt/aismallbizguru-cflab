import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED, evaluateSetup } from '../../scripts/backup/verify-setup.mjs';
import { createR2Client } from '../../scripts/backup/r2-client.mjs';
import { sourceClientFromEnvironment } from '../../scripts/backup/r2-mirror.mjs';

// The documented policy from docs/BACKUP-RESTORE.md.
function compliant(overrides = {}) {
  return {
    bucketExists: true,
    bucketInfo: { object_count: 4, bucket_size: '12 MB' },
    lockRules: [
      { prefix: 'd1/', condition: { type: 'Age', maxAgeSeconds: 30 * 86400 } },
      { prefix: 'files/', condition: { type: 'Age', maxAgeSeconds: 30 * 86400 } },
    ],
    lifecycleRules: [
      { prefix: 'd1/', deleteAfterDays: 90 },
      { prefix: 'files/', deleteAfterDays: 400 },
    ],
    publicAccess: { devUrl: false, domains: [] },
    credentials: { productionRead: 'ok', backupRead: 'ok' },
    probeWrite: 'ok',
    ...overrides,
  };
}

test('a compliant setup passes verification', () => {
  const result = evaluateSetup(compliant());
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.match(result.notes.join(' '), /lock "d1\/": 30 days/);
  assert.match(result.notes.join(' '), /lifecycle "files\/": expire after 400 days/);
});

test('a missing bucket is reported as the blocker instead of cascading errors', () => {
  const result = evaluateSetup({ bucketExists: false });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /does not exist/);
});

test('missing or weaker lock rules fail closed', () => {
  const missing = evaluateSetup(compliant({ lockRules: [{ prefix: 'd1/', condition: { type: 'Age', maxAgeSeconds: 30 * 86400 } }] }));
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(' '), /no bucket lock rule covers prefix "files\/"/);

  const weaker = evaluateSetup(compliant({ lockRules: [{ prefix: 'd1/', condition: { type: 'Age', maxAgeSeconds: 86400 } }, { prefix: 'files/', condition: { type: 'Indefinite' } }] }));
  assert.equal(weaker.ok, false);
  assert.match(weaker.problems.join(' '), /retains 1 day\(s\), below the documented 30/);
  assert.match(weaker.notes.join(' '), /lock "files\/": indefinite/);
});

test('missing, unreadable, or too-long lifecycle rules fail closed', () => {
  assert.match(evaluateSetup(compliant({ lifecycleRules: [] })).problems.join(' '), /no lifecycle rule covers prefix "d1\/"/);
  assert.match(evaluateSetup(compliant({ lifecycleRules: [{ prefix: 'd1/', deleteAfterDays: 365 }, { prefix: 'files/', deleteAfterDays: 400 }] })).problems.join(' '), /above the documented 90/);
  assert.match(evaluateSetup(compliant({ lifecycleRules: [{ prefix: 'd1/' }, { prefix: 'files/', deleteAfterDays: 400 }] })).problems.join(' '), /no readable expiration/);
});

test('public access and credential failures fail closed', () => {
  assert.match(evaluateSetup(compliant({ publicAccess: { devUrl: true, domains: [] } })).problems.join(' '), /public r2\.dev URL/);
  assert.match(evaluateSetup(compliant({ publicAccess: { devUrl: false, domains: ['backup.example.com'] } })).problems.join(' '), /custom domain/);
  assert.match(evaluateSetup(compliant({ credentials: { productionRead: 'HTTP 403', backupRead: 'ok' } })).problems.join(' '), /reading production failed: HTTP 403/);
  assert.match(evaluateSetup(compliant({ credentials: { productionRead: 'ok' } })).problems.join(' '), /reading the backup bucket failed/);
  assert.match(evaluateSetup(compliant({ probeWrite: 'HTTP 403' })).problems.join(' '), /writing to the backup bucket failed: HTTP 403/);
  assert.match(evaluateSetup(compliant({ probeWrite: undefined })).notes.join(' '), /backup write: not probed/);
});

test('the documented expectations are the ones the verifier enforces', () => {
  assert.equal(EXPECTED.bucket, 'cflab-backups');
  assert.deepEqual(EXPECTED.locks.map(rule => rule.prefix), ['d1/', 'files/']);
  assert.deepEqual(EXPECTED.lifecycles.map(rule => rule.prefix), ['d1/', 'files/']);
  assert.equal(EXPECTED.lifecycles[0].maxExpireDays, 90);
});

test('the production client refuses to write at all', async () => {
  const client = createR2Client({ accountId: 'acct', bucket: 'cflab-files', accessKeyId: 'AK', secretAccessKey: 'SK', readOnly: true, fetchImpl: async () => new Response('') });
  await assert.rejects(client.putObject('apps/x/photo.jpg', 'data'), /read-only \(production access must never write\)/);
});

test('the mirror source client is created read-only from the environment', () => {
  const client = sourceClientFromEnvironment({ CLOUDFLARE_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK' });
  assert.equal(client.bucket, 'cflab-files');
  assert.throws(() => sourceClientFromEnvironment({}), /missing R2 read configuration/);
});
