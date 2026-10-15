#!/usr/bin/env node
// Release record for the deploy job's run summary.
//
// The summary must never read like a success when a stage failed. A failure after
// the primary Worker is published leaves production *partially* updated, and that
// has to be visible in the summary: which Worker is live, which is not, and
// whether the revision was verified. The verdict and the production state are
// derived from the step outcomes, never asserted unconditionally.
//
// Usage:
//   node scripts/ci/release-summary.mjs            # appends to $GITHUB_STEP_SUMMARY
//   node scripts/ci/release-summary.mjs --stdout    # prints the markdown
//
// Inputs come from the environment so the workflow only has to pass step
// outcomes: REVISION, VALIDATION, MIGRATION_CHECK, MIGRATION_APPLY,
// PRIMARY_DEPLOY, PRIMARY_VERIFY, ANALYTICS_DEPLOY, ANALYTICS_VERIFY,
// PRIMARY_VERSION, ANALYTICS_VERSION.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);

function outcome(value) {
  const normalized = (value ?? '').trim().toLowerCase();
  return OUTCOMES.has(normalized) ? normalized : 'unknown';
}

// A stage is only "ok" when it ran and succeeded. Anything else (skipped,
// cancelled, unknown) is reported as not successful rather than assumed fine.
function isSuccess(value) {
  return outcome(value) === 'success';
}

export function buildReleaseSummary(steps) {
  const validation = outcome(steps.validation);
  const migrationCheck = outcome(steps.migrationCheck);
  const migrationApply = outcome(steps.migrationApply);
  const primaryDeploy = outcome(steps.primaryDeploy);
  const primaryVerify = outcome(steps.primaryVerify);
  const analyticsDeploy = outcome(steps.analyticsDeploy);
  const analyticsVerify = outcome(steps.analyticsVerify);

  const stages = [migrationCheck, migrationApply, primaryDeploy, primaryVerify, analyticsDeploy, analyticsVerify];
  const failed = stages.filter(stage => stage === 'failure');
  const incomplete = stages.filter(stage => stage === 'skipped' || stage === 'cancelled' || stage === 'unknown');
  const verdict = failed.length ? 'FAILED' : incomplete.length ? 'INCOMPLETE' : 'SUCCESS';

  // What production is actually running now, derived only from what succeeded.
  let productionState;
  if (!isSuccess(primaryDeploy) && !isSuccess(analyticsDeploy)) {
    productionState = 'Neither Worker was published by this run; production is unchanged.';
  } else if (isSuccess(primaryDeploy) && isSuccess(analyticsDeploy) && isSuccess(primaryVerify) && isSuccess(analyticsVerify)) {
    productionState = 'Both Workers were published and verified at the released revision.';
  } else if (isSuccess(primaryDeploy) && !isSuccess(analyticsDeploy)) {
    productionState = 'PARTIALLY UPDATED: the primary Worker was published, the Analytics Worker was not. The two Workers are on different revisions until this is resolved.';
  } else if (isSuccess(primaryDeploy) && !isSuccess(primaryVerify)) {
    productionState = 'AT RISK: the primary Worker was published but its production verification did not pass. Production may be broken; decide on a rollback (docs/CI-CD.md#rollback).';
  } else if (isSuccess(primaryDeploy) && isSuccess(analyticsDeploy) && !(isSuccess(primaryVerify) && isSuccess(analyticsVerify))) {
    productionState = 'AT RISK: both Workers were published but production verification did not pass for both. Decide on a rollback (docs/CI-CD.md#rollback).';
  } else {
    productionState = 'Review the stage outcomes below: production state is not fully determined.';
  }

  const lines = [
    '## CFLab release',
    '',
    `**Result: ${verdict}**${steps.revision ? ` — revision \`${steps.revision}\`` : ''}`,
    '',
    productionState,
    '',
    '| Stage | Outcome |',
    '| --- | --- |',
    `| validation (separate job) | ${validation} |`,
    `| migration check | ${migrationCheck} |`,
    `| migration apply | ${migrationApply} |`,
    `| primary Worker deploy | ${primaryDeploy}${steps.primaryVersion ? ` (\`${steps.primaryVersion}\`)` : ''} |`,
    `| primary Worker verification | ${primaryVerify} |`,
    `| Analytics Worker deploy | ${analyticsDeploy}${steps.analyticsVersion ? ` (\`${steps.analyticsVersion}\`)` : ''} |`,
    `| Analytics Worker verification | ${analyticsVerify} |`,
    '',
  ];

  if (verdict === 'SUCCESS') {
    lines.push('Both Workers report the released revision at `GET /api/version`; rollback and recovery commands are in docs/CI-CD.md.');
  } else {
    lines.push('This run did **not** complete a verified release. Do not treat production as updated: check the state above, then use docs/CI-CD.md (rollback, D1 recovery, emergency deployment) before the next attempt.');
  }

  return { verdict, productionState, markdown: `${lines.join('\n')}\n` };
}

function fromEnvironment(env) {
  const read = name => {
    const value = env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  return {
    revision: read('REVISION'),
    validation: read('VALIDATION'),
    migrationCheck: read('MIGRATION_CHECK'),
    migrationApply: read('MIGRATION_APPLY'),
    primaryDeploy: read('PRIMARY_DEPLOY'),
    primaryVerify: read('PRIMARY_VERIFY'),
    analyticsDeploy: read('ANALYTICS_DEPLOY'),
    analyticsVerify: read('ANALYTICS_VERIFY'),
    primaryVersion: read('PRIMARY_VERSION'),
    analyticsVersion: read('ANALYTICS_VERSION'),
  };
}

function main() {
  const { markdown, verdict } = buildReleaseSummary(fromEnvironment(process.env));
  if (process.argv.includes('--stdout') || !process.env.GITHUB_STEP_SUMMARY) {
    process.stdout.write(markdown);
  } else {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  // The summary never changes a run's outcome; --fail-on-failure exists so a
  // caller can assert the verdict deliberately.
  if (verdict === 'FAILED' && process.argv.includes('--fail-on-failure')) process.exitCode = 1;
}

// Importable for tests: the CLI only runs when this file is the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
