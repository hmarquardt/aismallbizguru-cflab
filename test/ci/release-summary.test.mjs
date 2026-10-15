import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseSummary } from '../../scripts/ci/release-summary.mjs';

const REVISION = '42a797b35dd32dc8d5474247a7f04ebcd99f6791';

// The outcomes a successful release produces. Individual tests break one stage at
// a time and assert the summary tells the truth about it.
function steps(overrides = {}) {
  return {
    revision: REVISION,
    validation: 'success',
    migrationCheck: 'success',
    migrationApply: 'success',
    primaryDeploy: 'success',
    primaryVerify: 'success',
    analyticsDeploy: 'success',
    analyticsVerify: 'success',
    primaryVersion: 'aaaa1111-2222-3333-4444-555566667777',
    analyticsVersion: 'bbbb1111-2222-3333-4444-555566667777',
    ...overrides,
  };
}

test('a fully successful release is reported as success with both version ids', () => {
  const { verdict, markdown } = buildReleaseSummary(steps());
  assert.equal(verdict, 'SUCCESS');
  assert.match(markdown, /\*\*Result: SUCCESS\*\*/);
  assert.match(markdown, new RegExp(REVISION));
  assert.match(markdown, /aaaa1111-2222-3333-4444-555566667777/);
  assert.match(markdown, /bbbb1111-2222-3333-4444-555566667777/);
  assert.match(markdown, /Both Workers were published and verified/);
});

test('a failed primary verification is never summarized as success', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({ primaryVerify: 'failure' }));
  assert.equal(verdict, 'FAILED');
  assert.match(markdown, /\*\*Result: FAILED\*\*/);
  assert.doesNotMatch(markdown, /Result: SUCCESS/);
  assert.match(markdown, /AT RISK/);
  assert.match(markdown, /did \*\*not\*\* complete a verified release/);
  assert.doesNotMatch(markdown, /Both Workers report the released revision/);
});

test('a partial release says which Worker is live and which is not', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({ analyticsDeploy: 'failure', analyticsVerify: 'skipped', analyticsVersion: undefined }));
  assert.equal(verdict, 'FAILED');
  assert.match(markdown, /PARTIALLY UPDATED/);
  assert.match(markdown, /primary Worker was published, the Analytics Worker was not/);
  assert.doesNotMatch(markdown, /Result: SUCCESS/);
});

test('a failure before any deploy states that production is unchanged', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({
    migrationApply: 'failure', primaryDeploy: 'skipped', primaryVerify: 'skipped',
    analyticsDeploy: 'skipped', analyticsVerify: 'skipped', primaryVersion: undefined, analyticsVersion: undefined,
  }));
  assert.equal(verdict, 'FAILED');
  assert.match(markdown, /Neither Worker was published by this run; production is unchanged/);
  assert.doesNotMatch(markdown, /Result: SUCCESS/);
});

test('skipped stages are reported as incomplete rather than assumed fine', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({ analyticsVerify: 'skipped' }));
  assert.equal(verdict, 'INCOMPLETE');
  assert.match(markdown, /\*\*Result: INCOMPLETE\*\*/);
  assert.match(markdown, /AT RISK/);
});

test('a cancelled release is reported as incomplete, not successful', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({ primaryVerify: 'cancelled', analyticsDeploy: 'cancelled', analyticsVerify: 'cancelled' }));
  assert.equal(verdict, 'INCOMPLETE');
  assert.doesNotMatch(markdown, /Result: SUCCESS/);
});

test('an unknown outcome is treated as not-successful rather than ignored', () => {
  const { verdict, markdown } = buildReleaseSummary(steps({ primaryDeploy: '' }));
  assert.equal(verdict, 'INCOMPLETE');
  assert.match(markdown, /primary Worker deploy \| unknown/);
  assert.doesNotMatch(markdown, /Result: SUCCESS/);
});

test('every stage outcome appears in the summary table', () => {
  const { markdown } = buildReleaseSummary(steps());
  for (const stage of ['validation (separate job)', 'migration check', 'migration apply', 'primary Worker deploy', 'primary Worker verification', 'Analytics Worker deploy', 'Analytics Worker verification']) {
    assert.ok(markdown.includes(`| ${stage} |`), `missing stage row: ${stage}`);
  }
});
