import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const release = readFileSync('.github/workflows/ci.yml', 'utf8');
const manual = readFileSync('.github/workflows/drift.yml', 'utf8');

test('drift is manual on demand and mandatory after a complete release', () => {
  assert.match(manual, /\n  workflow_dispatch:/);
  assert.doesNotMatch(manual, /\n  schedule:|\n\s+- cron:/);
  const deploy = release.slice(release.indexOf('\n  deploy:'));
  assert.match(deploy, /fetch-depth: 0/);
  assert.match(deploy, /needs: validate/);
  assert.match(deploy, /vars\.CLOUDFLARE_DEPLOY_ENABLED == 'true'/);
  const stages = ['id: deploy_primary', 'id: verify_primary', 'id: deploy_analytics', 'id: verify_analytics', 'id: verify_release', 'id: verify_drift', 'name: Record the release'];
  let previous = -1;
  for (const stage of stages) {
    const position = deploy.indexOf(stage);
    assert.ok(position > previous, `missing or out-of-order stage: ${stage}`);
    previous = position;
  }
  assert.match(deploy, /node scripts\/verify-production\.mjs --service all --revision "\$GITHUB_SHA"/);
  assert.match(deploy, /node scripts\/verify-drift\.mjs/);
  assert.doesNotMatch(deploy, /continue-on-error:/);
  assert.match(deploy, /RELEASE_VERIFY: \$\{\{ steps\.verify_release\.outcome \}\}/);
  assert.match(deploy, /DRIFT_VERIFY: \$\{\{ steps\.verify_drift\.outcome \}\}/);
});

test('partial releases retain drift diagnostics and logs without bypassing the failed primary gate', () => {
  const analyticsUpload = release.slice(release.indexOf('- name: Deploy the Analytics Worker'), release.indexOf('- name: Verify Analytics production'));
  assert.doesNotMatch(analyticsUpload, /if:|always\(\)/);
  assert.match(release, /if: always\(\) && \(steps\.deploy_primary\.outcome == 'success' \|\| steps\.deploy_primary\.outcome == 'failure'\)/);
  assert.match(release, /name: cflab-release-diagnostics/);
  assert.match(release, /set -euo pipefail/);
});
