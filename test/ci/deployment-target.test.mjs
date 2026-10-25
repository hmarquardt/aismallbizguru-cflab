import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseResourceChecks, deploymentTargetChecks, readConfig } from '../../scripts/ci/verify-deployment-target.mjs';

test('all three remote database identities must match the authoritative configuration', async () => {
  const databases = readConfig('wrangler.jsonc').d1_databases;
  const calls = [];
  const checks = await databaseResourceChecks({ token: 'test-only', fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    const database = databases.find(entry => url.endsWith(entry.database_id));
    return Response.json({ success: true, result: { uuid: database.database_id, name: database.database_name } });
  } });
  assert.equal(calls.length, 3);
  assert.equal(checks.every(check => check.ok), true);
  const wrong = await databaseResourceChecks({ token: 'test-only', fetchImpl: async () => Response.json({ success: true, result: { uuid: 'wrong', name: 'wrong' } }) });
  assert.equal(wrong.every(check => !check.ok), true);
  const unavailable = await databaseResourceChecks({ token: 'test-only', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(unavailable.every(check => !check.ok), true);
});

test('the configuration preflight rejects unprovisioned and duplicate database IDs', () => {
  const checks = deploymentTargetChecks();
  const signalsId = readConfig('wrangler.jsonc').d1_databases.find(entry => entry.binding === 'BTC_SIGNALS').database_id;
  assert.equal(checks.find(check => check.label.includes('is provisioned')).ok, !/^00000000-/.test(signalsId));
  assert.equal(checks.find(check => check.label.includes('bindings are distinct')).ok, true);
});
