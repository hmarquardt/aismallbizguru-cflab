#!/usr/bin/env node
// Production revision drift check — read-only, and it needs no credential.
//
// Both Workers publish the Git revision they were released from at
// `GET /api/version`. That is enough to answer the questions that matter without
// touching Cloudflare:
//
//   1. Is production running a revision published by the pipeline at all, or one
//      that exists only on somebody's machine (the drift this repository hit
//      before Phase 2)?
//   2. Are the two Workers on the same revision? They are released together, so
//      a split means a release was interrupted or someone deployed one by hand.
//   3. How far is production behind `main`? That is informational — being behind
//      simply means a release is pending — while *divergence* is a failure.
//
// The ancestry check uses the local clone, so run it from a full clone of `main`
// (the scheduled workflow checks out with `fetch-depth: 0`).
//
// Usage: node scripts/verify-drift.mjs [--primary <origin>] [--analytics <origin>]
//                                      [--main <git-ref>]

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ORIGINS = {
  primary: 'https://cflab.aismallbizguru.com',
  analytics: 'https://analytics.aismallbizguru.com',
};
const EXPECTED = { primary: 'cflab', analytics: 'cflab-analytics' };
const REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const REQUEST_TIMEOUT_MS = 20000;

// Pure classification so the rules are testable without a network or a clone.
export function classifyDrift({ primaryRevision, analyticsRevision, mainRevision, isAncestorOfMain, commitsBehindMain }) {
  const unknown = [primaryRevision, analyticsRevision].some(revision => !revision || revision === 'unknown');
  if (unknown) {
    return {
      verdict: 'unknown-revision',
      ok: false,
      messages: ['Production did not report a revision for both Workers, so it was not published by this pipeline (or the deployed build predates GET /api/version). Run node scripts/verify-production.mjs --service all and reconcile before releasing.'],
    };
  }
  if (primaryRevision !== analyticsRevision) {
    return {
      verdict: 'split',
      ok: false,
      messages: [`The Workers are on different revisions: primary ${primaryRevision}, analytics ${analyticsRevision}. They are released together, so a release was interrupted or one Worker was deployed outside the pipeline.`],
    };
  }
  if (isAncestorOfMain === false) {
    return {
      verdict: 'drift',
      ok: false,
      messages: [`Production is running ${primaryRevision}, which is not in the history of ${mainRevision ?? 'the main branch'}. It was not published from main. Commit it (if intended) or roll production back, then reconcile before the next release.`],
    };
  }
  if (isAncestorOfMain === null || isAncestorOfMain === undefined) {
    return {
      verdict: 'unverified',
      ok: false,
      messages: [`Production reports ${primaryRevision}, but its ancestry could not be checked in this clone (is the revision present? was the clone shallow?).`],
    };
  }
  if (commitsBehindMain === 0) {
    return { verdict: 'in-sync', ok: true, messages: [`Production is on ${primaryRevision}, which is exactly main.`] };
  }
  return {
    verdict: 'behind',
    ok: true,
    messages: [`Production is on ${primaryRevision}, ${commitsBehindMain} commit(s) behind main (${mainRevision}). That is a pending release, not drift.`],
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function ancestry(revision, mainRef) {
  try {
    const mainRevision = git(['rev-parse', mainRef]);
    let isAncestor;
    try {
      git(['merge-base', '--is-ancestor', revision, mainRef]);
      isAncestor = true;
    } catch {
      // A non-zero exit means "not an ancestor" or "unknown object"; tell them apart.
      git(['cat-file', '-e', `${revision}^{commit}`]);
      isAncestor = false;
    }
    const behind = Number(git(['rev-list', '--count', `${revision}..${mainRef}`]));
    return { mainRevision, isAncestorOfMain: isAncestor, commitsBehindMain: Number.isFinite(behind) ? behind : null };
  } catch {
    return { mainRevision: null, isAncestorOfMain: null, commitsBehindMain: null };
  }
}

async function readRevision(origin, service, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}/api/version`, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${origin}/api/version could not be reached (${error?.cause?.code ?? error?.name ?? 'network error'})`);
  }
  if (response.status !== 200) throw new Error(`${origin}/api/version returned HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error(`${origin}/api/version did not return a JSON object`);
  if (body.service !== service) throw new Error(`${origin}/api/version reports service "${body.service}" instead of "${service}"`);
  if (typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
    throw new Error(`${origin}/api/version did not report a usable revision`);
  }
  return body.revision;
}

function parseArgs(argv) {
  const options = { origins: { ...ORIGINS }, main: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--primary') { options.origins.primary = value; index += 1; }
    else if (flag === '--analytics') { options.origins.analytics = value; index += 1; }
    else if (flag === '--main') { options.main = value; index += 1; }
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

const USAGE = 'Usage: node scripts/verify-drift.mjs [--primary <origin>] [--analytics <origin>] [--main <git-ref>]';

export async function runDriftCheck({ argv = process.argv.slice(2), fetchImpl = fetch, log = console.log } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return { verdict: 'help', ok: true };
  }
  const primaryRevision = await readRevision(options.origins.primary, EXPECTED.primary, fetchImpl);
  const analyticsRevision = await readRevision(options.origins.analytics, EXPECTED.analytics, fetchImpl);
  log(`production: primary ${primaryRevision}, analytics ${analyticsRevision}`);
  const result = classifyDrift({ primaryRevision, analyticsRevision, ...ancestry(primaryRevision, options.main) });
  for (const message of result.messages) log(`${result.ok ? 'INFO' : 'FAIL'}  ${message}`);
  log(`${result.ok ? 'PASS' : 'FAIL'}: production drift check verdict is ${result.verdict}`);
  return result;
}

// Importable for tests: the CLI only runs when this file is the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runDriftCheck();
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
