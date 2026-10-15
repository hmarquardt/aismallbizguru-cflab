import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyDrift } from '../../scripts/verify-drift.mjs';

const REVISION = '42a797b35dd32dc8d5474247a7f04ebcd99f6791';
const OLDER = '135ce211c095273696a98648ff1986cb2e61807d';

test('production exactly on main is in sync', () => {
  const result = classifyDrift({ primaryRevision: REVISION, analyticsRevision: REVISION, mainRevision: REVISION, isAncestorOfMain: true, commitsBehindMain: 0 });
  assert.equal(result.verdict, 'in-sync');
  assert.equal(result.ok, true);
});

test('production behind main is a pending release, not drift', () => {
  const result = classifyDrift({ primaryRevision: OLDER, analyticsRevision: OLDER, mainRevision: REVISION, isAncestorOfMain: true, commitsBehindMain: 3 });
  assert.equal(result.verdict, 'behind');
  assert.equal(result.ok, true);
  assert.match(result.messages.join(' '), /pending release, not drift/);
});

test('a revision that is not in main history is reported as drift', () => {
  const result = classifyDrift({ primaryRevision: REVISION, analyticsRevision: REVISION, mainRevision: OLDER, isAncestorOfMain: false, commitsBehindMain: null });
  assert.equal(result.verdict, 'drift');
  assert.equal(result.ok, false);
  assert.match(result.messages.join(' '), /not in the history of/);
});

test('Workers on different revisions are reported as a split release', () => {
  const result = classifyDrift({ primaryRevision: REVISION, analyticsRevision: OLDER, mainRevision: REVISION, isAncestorOfMain: true, commitsBehindMain: 0 });
  assert.equal(result.verdict, 'split');
  assert.equal(result.ok, false);
});

test('an unreported revision fails rather than passing quietly', () => {
  for (const revision of ['unknown', undefined]) {
    const result = classifyDrift({ primaryRevision: revision, analyticsRevision: revision, mainRevision: REVISION, isAncestorOfMain: true, commitsBehindMain: 0 });
    assert.equal(result.verdict, 'unknown-revision');
    assert.equal(result.ok, false);
  }
});

test('an unverifiable ancestry fails instead of assuming the revision is fine', () => {
  const result = classifyDrift({ primaryRevision: REVISION, analyticsRevision: REVISION, mainRevision: null, isAncestorOfMain: null, commitsBehindMain: null });
  assert.equal(result.verdict, 'unverified');
  assert.equal(result.ok, false);
});

test('npm run deploy refuses, explains the policy, and points at the runbook', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/refuse-direct-deploy.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /GitHub Actions/);
  assert.match(output, /AGENTS\.md/);
  assert.match(output, /docs\/CI-CD\.md/);
  // It must not hand out a deploy command that would bypass the pipeline.
  assert.doesNotMatch(output, /wrangler deploy --config/);
  assert.doesNotMatch(output, /wrangler deploy --no-x-provision/);
});

test('the npm deploy script is wired to the refusal, not to wrangler', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.deploy, 'node scripts/ci/refuse-direct-deploy.mjs');
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (name === 'deploy') continue;
    assert.doesNotMatch(script, /wrangler deploy(?! --dry-run)/, `${name} must not deploy production`);
    assert.doesNotMatch(script, /wrangler d1 migrations apply(?![^\n]*--local)/, `${name} must not apply remote migrations`);
    assert.doesNotMatch(script, /wrangler rollback/, `${name} must not roll back production`);
  }
});
