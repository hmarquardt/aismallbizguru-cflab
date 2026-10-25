import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyService } from '../../scripts/verify-production.mjs';

// These tests never contact a network: a fake fetch answers the probe under test
// and fails every other probe with a synthetic network error. They assert the
// failure taxonomy, which is what lets a release problem be told apart from a
// network problem, an unexpected status code, or an incorrect deployed version.
const REVISION = 'f406792bf53cff4c4648b941dcb6c81b66d460f3';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fetchAnsweringVersion(handler) {
  return async (url, init) => {
    if (new URL(url).pathname === '/api/version') return handler(init);
    throw Object.assign(new Error('blocked in test'), { cause: { code: 'ECONNREFUSED' } });
  };
}

function verifyPrimary(fetchImpl) {
  return verifyService('cflab', { revision: REVISION, fetchImpl, log: () => {} });
}

function rejectsWithCategory(fetchImpl, category) {
  return async () => {
    await assert.rejects(verifyPrimary(fetchImpl), error => {
      assert.equal(error.category, 'checks');
      assert.match(error.message, new RegExp(`\\[${category}\\]`), `expected a ${category} failure in: ${error.message}`);
      return true;
    });
  };
}

test('a completely unreachable deployment fails every check as a network failure', async () => {
  await assert.rejects(verifyPrimary(async () => { throw new Error('down'); }), error => {
    assert.equal(error.category, 'checks');
    assert.match(error.message, /12 of 12 production checks failed for cflab/);
    assert.match(error.message, /\[network\]/);
    return true;
  });
});

test('an unexpected status code is reported as a status failure, not a network failure', rejectsWithCategory(
  fetchAnsweringVersion(() => new Response('unavailable', { status: 500 })), 'status'));

test('a redirect is reported as a redirect failure', rejectsWithCategory(
  fetchAnsweringVersion(() => new Response('', { status: 302, headers: { location: 'https://example.com/' } })), 'redirect'));

test('a different service identity is reported as a body failure', rejectsWithCategory(
  fetchAnsweringVersion(() => jsonResponse({ service: 'cflab-analytics', revision: REVISION })), 'body'));

test('a non-JSON response is reported as a body failure', rejectsWithCategory(
  fetchAnsweringVersion(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } })), 'body'));

test('a response that reports no revision is reported as a revision failure', rejectsWithCategory(
  fetchAnsweringVersion(() => jsonResponse({ service: 'cflab' })), 'revision'));

test('an unreported revision is reported as a revision failure', rejectsWithCategory(
  fetchAnsweringVersion(() => jsonResponse({ service: 'cflab', revision: 'unknown' })), 'revision'));

test('a deployed revision that is not this release is reported as a revision failure', async () => {
  await assert.rejects(verifyPrimary(fetchAnsweringVersion(() => jsonResponse({ service: 'cflab', revision: 'deadbeef' }))), error => {
    assert.match(error.message, /\[revision\]/);
    assert.match(error.message, /deadbeef/);
    assert.match(error.message, new RegExp(REVISION));
    return true;
  });
});

test('the Analytics service reports its own probes and categories', async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === '/api/version') return jsonResponse({ service: 'cflab', revision: REVISION });
    throw Object.assign(new Error('blocked in test'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(verifyService('analytics', { revision: REVISION, fetchImpl, log: () => {} }), error => {
    assert.match(error.message, /production checks failed for analytics/);
    assert.match(error.message, /analytics deployment identity/);
    assert.match(error.message, /\[body\]/);
    return true;
  });
});
