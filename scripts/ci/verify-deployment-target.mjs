#!/usr/bin/env node
// Deployment-target preflight for the CFLab release pipeline.
//
// Runs before anything is applied or published. It verifies that the checkout is
// about to deploy to the intended production account and resources, that the
// validated bundles are present, and that the credentials the release needs are
// available. It never prints a credential value.
//
// The expectations below are deliberate production guards, not derived defaults:
// they are what stops a release from silently dropping a binding, repointing a
// database, or publishing the wrong Worker. If a change is intentional, update
// the expectation in the same reviewed commit. See docs/CI-CD.md.
//
// Usage: node scripts/ci/verify-deployment-target.mjs [--config-only]

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT_ID = 'b1aa310aa0a1638d72b8b086a21e557c';
const ZONE = 'aismallbizguru.com';
const PRIMARY_ORIGIN = 'https://cflab.aismallbizguru.com';
const ANALYTICS_ORIGIN = 'https://analytics.aismallbizguru.com';
const PRIMARY_DATABASE_ID = 'cb2d2eb4-2817-4581-8e50-d69212650adf';
const ANALYTICS_DATABASE_ID = '54e8af8e-3345-40e7-88fd-462a688421b5';
const FILES_BUCKET = 'cflab-files';
const REQUIRED_RATE_LIMITS = ['RL_ANALYTICS', 'RL_INVITE', 'RL_LOGIN', 'RL_RECOVERY', 'RL_RESET'];

class TargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetError';
  }
}

// Removes // and /* */ comments while respecting string literals, so the
// committed JSONC configuration can be parsed without another dependency.
export function stripJsonComments(source) {
  let result = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      result += character;
      if (character === '\\') { result += next ?? ''; index += 1; continue; }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; result += character; continue; }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      result += ' ';
      continue;
    }
    result += character;
  }
  return result;
}

export function readConfig(path) {
  if (!existsSync(path)) throw new TargetError(`${path} is missing from this checkout`);
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new TargetError(`${path} could not be parsed: ${error.message}`);
  }
}

function valueAt(object, path) {
  return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

function routePresent(config, pattern) {
  return (config.routes ?? []).some(route => route.pattern === pattern);
}

function d1Binding(config, binding) {
  return (config.d1_databases ?? []).find(database => database.binding === binding);
}

function rateLimitNames(config) {
  return (config.ratelimits ?? []).map(limit => limit.name).sort();
}

function serviceBinding(config, binding) {
  return (config.services ?? []).find(service => service.binding === binding);
}

// Returns the production expectations as comparable checks. `actual` values are
// rendered in the report, so they must never contain a credential.
export function deploymentTargetChecks() {
  const primary = readConfig('wrangler.jsonc');
  const analytics = readConfig('wrangler.analytics.jsonc');
  const checks = [];
  const equals = (label, actual, expected) => checks.push({ label, actual, expected, ok: actual === expected });
  const truthy = (label, actual) => checks.push({ label, actual, expected: 'a non-empty value', ok: typeof actual === 'string' && actual.length > 0 });

  // Primary Worker (cflab): identity, routing, data resources, and the bindings
  // production depends on today.
  equals('wrangler.jsonc name', primary.name, 'cflab');
  equals('wrangler.jsonc main', primary.main, 'src/index.ts');
  equals('wrangler.jsonc account_id', primary.account_id, ACCOUNT_ID);
  equals('wrangler.jsonc workers_dev', primary.workers_dev, false);
  equals('wrangler.jsonc preview_urls', primary.preview_urls, false);
  equals('wrangler.jsonc route cflab custom domain', routePresent(primary, new URL(PRIMARY_ORIGIN).hostname), true);
  equals('wrangler.jsonc route lab zone route', routePresent(primary, `lab.${ZONE}/*`), true);
  equals('wrangler.jsonc DB database_name', d1Binding(primary, 'DB')?.database_name, 'cflab');
  equals('wrangler.jsonc DB database_id', d1Binding(primary, 'DB')?.database_id, PRIMARY_DATABASE_ID);
  equals('wrangler.jsonc DB migrations_dir', d1Binding(primary, 'DB')?.migrations_dir, 'migrations');
  equals('wrangler.jsonc ANALYTICS database_id', d1Binding(primary, 'ANALYTICS')?.database_id, ANALYTICS_DATABASE_ID);
  equals('wrangler.jsonc FILES bucket', (primary.r2_buckets ?? []).find(bucket => bucket.binding === 'FILES')?.bucket_name, FILES_BUCKET);
  equals('wrangler.jsonc send_email EMAIL binding', (primary.send_email ?? []).some(binding => binding.name === 'EMAIL'), true);
  truthy('wrangler.jsonc vars.AUTH_FROM_EMAIL', valueAt(primary, 'vars.AUTH_FROM_EMAIL'));
  equals('wrangler.jsonc vars.AUTH_PUBLIC_BASE_URL', valueAt(primary, 'vars.AUTH_PUBLIC_BASE_URL'), PRIMARY_ORIGIN);
  equals('wrangler.jsonc rate limits', rateLimitNames(primary).join(', '), REQUIRED_RATE_LIMITS.join(', '));

  // Analytics Worker: its own routing, storage, service binding, and schedule.
  equals('wrangler.analytics.jsonc name', analytics.name, 'cflab-analytics');
  equals('wrangler.analytics.jsonc main', analytics.main, 'src/analytics/index.ts');
  equals('wrangler.analytics.jsonc account_id', analytics.account_id, ACCOUNT_ID);
  equals('wrangler.analytics.jsonc workers_dev', analytics.workers_dev, false);
  equals('wrangler.analytics.jsonc preview_urls', analytics.preview_urls, false);
  equals('wrangler.analytics.jsonc route analytics custom domain', routePresent(analytics, new URL(ANALYTICS_ORIGIN).hostname), true);
  equals('wrangler.analytics.jsonc route cflab collect', routePresent(analytics, `cflab.${ZONE}/api/analytics/collect*`), true);
  equals('wrangler.analytics.jsonc route lab collect', routePresent(analytics, `lab.${ZONE}/api/analytics/collect*`), true);
  equals('wrangler.analytics.jsonc assets directory', valueAt(analytics, 'assets.directory'), './analytics-ui');
  equals('wrangler.analytics.jsonc ANALYTICS database_id', d1Binding(analytics, 'ANALYTICS')?.database_id, ANALYTICS_DATABASE_ID);
  equals('wrangler.analytics.jsonc CFLAB service', serviceBinding(analytics, 'CFLAB')?.service, 'cflab');
  equals('wrangler.analytics.jsonc CFLAB entrypoint', serviceBinding(analytics, 'CFLAB')?.entrypoint, 'HumanAuthService');
  equals('wrangler.analytics.jsonc rate limits', rateLimitNames(analytics).join(', '), 'RL_ANALYTICS');
  equals('wrangler.analytics.jsonc cron trigger', (valueAt(analytics, 'triggers.crons') ?? []).length > 0, true);

  return checks;
}

// Environment and artifact checks that only apply to a real release run.
export function releaseChecks() {
  const checks = [];
  const present = (label, value) => checks.push({ label, actual: value ? 'present' : 'missing', expected: 'present', ok: Boolean(value) });
  present('CLOUDFLARE_API_TOKEN', process.env.CLOUDFLARE_API_TOKEN);
  present('CLOUDFLARE_D1_API_TOKEN', process.env.CLOUDFLARE_D1_API_TOKEN);
  checks.push({
    label: 'CLOUDFLARE_ACCOUNT_ID',
    actual: process.env.CLOUDFLARE_ACCOUNT_ID ?? 'unset',
    expected: ACCOUNT_ID,
    ok: process.env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT_ID,
  });
  checks.push({
    label: 'GITHUB_SHA (released revision)',
    actual: process.env.GITHUB_SHA ?? 'unset',
    expected: 'a 40-character commit SHA',
    ok: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ''),
  });
  for (const artifact of ['dist/index.js', 'dist-analytics/index.js']) {
    checks.push({
      label: `validated build artifact ${artifact}`,
      actual: existsSync(artifact) ? 'present' : 'missing',
      expected: 'present',
      ok: existsSync(artifact),
    });
  }
  return checks;
}

function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

export function report(checks, log = console.log) {
  const failures = checks.filter(check => !check.ok);
  for (const check of checks) {
    log(`${check.ok ? 'OK  ' : 'FAIL'}  ${check.label}: ${check.ok ? String(check.actual) : `expected ${JSON.stringify(check.expected)}, received ${JSON.stringify(check.actual)}`}`);
  }
  return failures;
}

function main() {
  const configOnly = process.argv.includes('--config-only');
  const checks = configOnly ? deploymentTargetChecks() : [...deploymentTargetChecks(), ...releaseChecks()];
  const failures = report(checks);
  const summary = ['## Deployment target', '', ...failures.map(failure => `- FAILED: ${failure.label} (expected ${JSON.stringify(failure.expected)}, received ${JSON.stringify(failure.actual)})`)];
  if (failures.length) {
    summary.push('', `Blocked before any production change: ${failures.length} of ${checks.length} deployment-target checks failed.`);
    writeSummary(summary);
    console.error(`FAILED: ${failures.length} of ${checks.length} deployment-target checks failed. Nothing was deployed.`);
    process.exitCode = 1;
    return;
  }
  summary.push(`All ${checks.length} deployment-target checks passed.`);
  writeSummary(summary);
  console.log(`PASS: ${checks.length} deployment-target checks passed`);
}

// Importable as a library (the release tooling reads both Wrangler configs):
// the CLI only runs when this file is the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
