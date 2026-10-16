import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED, evaluateSetup, lifecycleRulesFromOutput, lockRulesFromOutput, parseRuleBlocks,
} from '../../scripts/backup/verify-setup.mjs';
import { createR2Client } from '../../scripts/backup/r2-client.mjs';
import { sourceClientFromEnvironment } from '../../scripts/backup/r2-mirror.mjs';

// Actual `wrangler r2 bucket lock|lifecycle list` output, captured 2026-10-16.
const LOCK_OUTPUT = `
Listing lock rules for bucket 'cflab-backups'...

name:       protect-d1-backups
enabled:    Yes
prefix:     d1/
condition:  after 30 days

name:       protect-file-mirror
enabled:    Yes
prefix:     files/
condition:  after 30 days
`;

const LIFECYCLE_OUTPUT = `
Listing lifecycle rules for bucket 'cflab-backups'...

name:     Default Multipart Abort Rule
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 7 days

name:     expire-d1-backups
enabled:  Yes
prefix:   d1/
action:   Expire objects after 90 days

name:     expire-file-mirror
enabled:  Yes
prefix:   files/
action:   Expire objects after 400 days
`;

test('lock rule output is parsed into the documented shape', () => {
  const rules = lockRulesFromOutput(LOCK_OUTPUT);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map(rule => rule.prefix), ['d1/', 'files/']);
  assert.equal(rules[0].condition.maxAgeSeconds, 30 * 86400);
  assert.equal(rules[0].enabled, true);
});

test('lifecycle rule output is parsed and the default multipart rule is kept distinct', () => {
  const rules = lifecycleRulesFromOutput(LIFECYCLE_OUTPUT);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map(rule => rule.prefix), ['', 'd1/', 'files/']);
  assert.equal(rules[1].deleteAfterDays, 90);
  assert.equal(rules[2].deleteAfterDays, 400);
  assert.equal(rules[0].deleteAfterDays, undefined);
  assert.equal(parseRuleBlocks(LIFECYCLE_OUTPUT).length, 3);
});

test('the live bucket configuration satisfies the documented policy', () => {
  const result = evaluateSetup({
    bucketExists: true,
    bucketInfo: { object_count: 0, bucket_size: '0 B' },
    lockRules: lockRulesFromOutput(LOCK_OUTPUT),
    lifecycleRules: lifecycleRulesFromOutput(LIFECYCLE_OUTPUT),
    publicAccess: { devUrl: false, domains: [] },
    credentials: { productionRead: 'ok', backupRead: 'ok' },
    probeWrite: 'ok',
  });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.match(result.notes.join(' '), /lock "d1\/": 30 days/);
  assert.match(result.notes.join(' '), /lock "files\/": 30 days/);
  assert.match(result.notes.join(' '), /lifecycle "d1\/": expire after 90 days/);
  assert.match(result.notes.join(' '), /lifecycle "files\/": expire after 400 days/);
});

test('a weaker live configuration still fails the same policy', () => {
  const weakened = evaluateSetup({
    bucketExists: true,
    lockRules: lockRulesFromOutput(LOCK_OUTPUT.replace('after 30 days', 'after 7 days')),
    lifecycleRules: lifecycleRulesFromOutput(LIFECYCLE_OUTPUT.replace('after 90 days', 'after 900 days')),
    publicAccess: { devUrl: false, domains: [] },
    credentials: { productionRead: 'ok', backupRead: 'ok' },
    probeWrite: 'ok',
  });
  assert.equal(weakened.ok, false);
  assert.match(weakened.problems.join(' '), /below the documented 30/);
  assert.match(weakened.problems.join(' '), /above the documented 90/);
});

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

test('the mirror source client requires its own read-only credentials', () => {
  const client = sourceClientFromEnvironment({
    CLOUDFLARE_ACCOUNT_ID: 'acct', R2_SOURCE_ACCESS_KEY_ID: 'SRC', R2_SOURCE_SECRET_ACCESS_KEY: 'SRCSECRET',
  });
  assert.equal(client.bucket, 'cflab-files');
  assert.throws(() => sourceClientFromEnvironment({}), /missing production read configuration/);
  // The write-capable pair must never stand in for the production read pair.
  assert.throws(
    () => sourceClientFromEnvironment({ CLOUDFLARE_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK' }),
    /missing production read configuration/,
  );
});

test('sharing one credential pair between production and backups is flagged', () => {
  const shared = evaluateSetup({ ...compliant(), credentials: { productionRead: 'ok', backupRead: 'ok', separateCredentials: false }, probeWrite: 'ok' });
  assert.equal(shared.ok, false);
  assert.match(shared.problems.join(' '), /same pair/);
  const separate = evaluateSetup({ ...compliant(), credentials: { productionRead: 'ok', backupRead: 'ok', separateCredentials: true }, probeWrite: 'ok' });
  assert.equal(separate.ok, true, separate.problems.join('; '));
  assert.match(separate.notes.join(' '), /separate pairs/);
});
