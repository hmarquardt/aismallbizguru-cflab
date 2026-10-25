#!/usr/bin/env node
// Read-only production verification for the CFLab release pipeline.
//
// Guarantees this script is built around:
//   * Only GET requests, plus POSTs to the two analytics collector paths with a
//     deliberately unmatched Site identifier. Both implementations answer an
//     unknown Site before writing anything, so no analytics event is created.
//   * No credentials are used, and none are required. No account, session,
//     record, file, R2 object, or email is created, changed, or deleted.
//   * No admin, backup, seed, or write route is probed. Nothing is provisioned.
//
// Failure categories are distinct so a release problem is never confused with an
// unrelated one:
//   network  - the request could not be completed (DNS, TLS, timeout, reset)
//   redirect - a 3xx response where the contract requires a direct response
//   status   - an unexpected HTTP status code
//   body     - an unexpected response body, shape, content type, or size
//   revision - the deployed revision is missing, unknown, or not this release
//   checks   - one or more of the probes above failed
//
// Usage:
//   node scripts/verify-production.mjs [--service cflab|analytics|all]
//     [--revision <sha>] [--wait] [--primary <origin>] [--analytics <origin>]
//     [--cutover <origin>]
//
// `--wait` retries the complete check set for up to two minutes, which is used
// after a deployment. Without it the script fails immediately (manual use).

import { pathToFileURL } from 'node:url';
import { verifyUntilReady } from './verify-readiness.mjs';

export class VerificationError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'VerificationError';
    this.category = category;
  }
}

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const ORIGINS = {
  primary: 'https://cflab.aismallbizguru.com',
  analytics: 'https://analytics.aismallbizguru.com',
  // The cutover hostname must keep serving CFLab and the analytics collect route.
  cutover: 'https://lab.aismallbizguru.com',
};

// Well-formed but unregistered credentials. CFLab hashes the machine token and
// finds no row; Analytics forwards the session token to the CFLAB service
// binding, which reports no session. Neither can match, so neither is an
// account, and neither creates or changes anything.
const UNKNOWN_MACHINE_TOKEN = `cfl_${'0'.repeat(64)}`;
const UNKNOWN_SESSION_TOKEN = `cflu_${'0'.repeat(64)}`;
// Deliberately unmatched Site identifier for the collector paths.
const UNKNOWN_SITE = 'cflab-release-verification-unknown-site';

function assert(condition, category, message) {
  if (!condition) throw new VerificationError(category, message);
}

function jsonIdentity(expectedService, expectedRevision) {
  return ({ json, name }) => {
    assert(json !== null && typeof json === 'object', 'body', `${name}: response body is not a JSON object`);
    assert(json.service === expectedService, 'body', `${name}: expected service "${expectedService}", received ${JSON.stringify(json.service ?? null)}`);
    if (expectedRevision === undefined) return;
    assert(typeof json.revision === 'string', 'revision', `${name}: response did not report a deployment revision`);
    assert(json.revision !== 'unknown', 'revision', `${name}: the deployed revision was not reported, so the running release was not published by this pipeline`);
    assert(json.revision === expectedRevision, 'revision', `${name}: deployed revision ${json.revision} is not the intended release ${expectedRevision}`);
  };
}

function jsonArray(field) {
  return ({ json, name }) => {
    assert(json !== null && typeof json === 'object', 'body', `${name}: response body is not a JSON object`);
    assert(Array.isArray(json[field]), 'body', `${name}: expected a "${field}" array, received ${JSON.stringify(Object.keys(json))}`);
  };
}

function emptyBody() {
  return ({ text, name }) => assert(text.length === 0, 'body', `${name}: expected an empty body, received ${text.length} bytes`);
}

function primaryChecks(revision, origins) {
  return [
    {
      name: 'primary health', url: `${origins.primary}/api/health`, status: 200,
      verify: jsonIdentity('cflab', undefined),
    },
    {
      name: 'primary deployment identity', url: `${origins.primary}/api/version`, status: 200,
      verify: jsonIdentity('cflab', revision),
    },
    {
      name: 'admin API rejects unauthenticated access', url: `${origins.primary}/api/admin/apps`, status: 401,
    },
    {
      name: 'app API rejects unauthenticated access', url: `${origins.primary}/api/apps/wildlife-field-recorder`, status: 401,
    },
    {
      name: 'app API rejects an unregistered machine token', url: `${origins.primary}/api/apps/wildlife-field-recorder`, status: 401,
      headers: { Authorization: `Bearer ${UNKNOWN_MACHINE_TOKEN}` },
    },
    {
      name: 'public Top Hat Ferals projection', url: `${origins.primary}/api/public/top-hat-ferals/cats`, status: 200,
      verify: jsonArray('records'),
    },
    {
      name: 'public Wildlife Safari projection', url: `${origins.primary}/api/public/wildlife-safari/observations?limit=1`, status: 200,
      verify: jsonArray('observations'),
    },
    {
      name: 'cutover hostname serves CFLab', url: `${origins.cutover}/api/health`, status: 200,
      verify: jsonIdentity('cflab', undefined),
    },
    // Bitcoin Signals: the dashboard shell is public HTML with no data, and its API
    // requires a human session. Neither probe reads or writes project data.
    {
      name: 'Bitcoin Signals dashboard shell', url: `${origins.primary}/bitcoin-signals`, status: 200,
      contentType: 'text/html',
      verify: ({ text, name }) => {
        for (const section of ['panel-radar', 'panel-arbitrage', 'panel-evidence', 'panel-settings']) {
          assert(text.includes(section), 'body', `${name}: the dashboard shell is missing ${section}`);
        }
      },
    },
    {
      name: 'Bitcoin Signals API rejects unauthenticated access',
      url: `${origins.primary}/api/bitcoin-signals/radar`, status: 401,
    },
    {
      name: 'Bitcoin Signals API rejects a machine token',
      url: `${origins.primary}/api/bitcoin-signals/radar`, status: 401,
      headers: { Authorization: `Bearer ${UNKNOWN_MACHINE_TOKEN}` },
    },
    {
      name: 'Bitcoin Signals API rejects an unknown human session',
      url: `${origins.primary}/api/bitcoin-signals/radar`, status: 401,
      headers: { Authorization: `Bearer ${UNKNOWN_SESSION_TOKEN}` },
    },
  ];
}

function analyticsChecks(revision, origins) {
  return [
    {
      name: 'analytics health', url: `${origins.analytics}/api/health`, status: 200,
      verify: jsonIdentity('cflab-analytics', undefined),
    },
    {
      name: 'analytics deployment identity', url: `${origins.analytics}/api/version`, status: 200,
      verify: jsonIdentity('cflab-analytics', revision),
    },
    {
      name: 'analytics dashboard assets', url: `${origins.analytics}/`, status: 200,
      contentType: 'text/html',
    },
    {
      name: 'site API rejects unauthenticated access', url: `${origins.analytics}/api/sites`, status: 401,
    },
    {
      name: 'site API rejects an unknown session through the CFLAB service binding',
      url: `${origins.analytics}/api/sites`, status: 401,
      headers: { Authorization: `Bearer ${UNKNOWN_SESSION_TOKEN}` },
      note: 'a 503 here means the CFLAB service binding is not working',
    },
    {
      name: 'canonical collector answers an unknown Site without recording',
      url: `${origins.analytics}/collect`, method: 'POST', body: { site: UNKNOWN_SITE }, status: 204,
      verify: emptyBody(),
      note: 'no event is written for an unknown Site',
    },
    {
      name: 'legacy collector route answers an unknown Site without recording',
      url: `${origins.analytics}/api/analytics/collect`, method: 'POST', body: { site_id: UNKNOWN_SITE }, status: 204,
      verify: emptyBody(),
      note: 'no event is written for an unknown Site',
    },
    {
      name: 'primary collect route reaches the Analytics Worker',
      url: `${origins.primary}/api/analytics/collect`, method: 'POST', body: { site_id: UNKNOWN_SITE }, status: 204,
      note: 'the legacy CFLab collector answers 404 for an unknown site, so 204 proves the Analytics Worker owns this route',
    },
    {
      name: 'cutover collect route reaches the Analytics Worker',
      url: `${origins.cutover}/api/analytics/collect`, method: 'POST', body: { site_id: UNKNOWN_SITE }, status: 204,
      note: 'the legacy CFLab collector answers 404 for an unknown site, so 204 proves the Analytics Worker owns this route',
    },
  ];
}

async function runCheck(check, fetchImpl) {
  const headers = { ...(check.headers ?? {}) };
  const init = { method: check.method ?? 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (check.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(check.body);
  }
  let response;
  try {
    response = await fetchImpl(check.url, init);
  } catch (error) {
    throw new VerificationError('network', `${check.name}: ${check.url} could not be reached (${error?.cause?.code ?? error?.name ?? 'unknown error'})`);
  }
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new VerificationError('network', `${check.name}: the response body could not be read (${error?.name ?? 'unknown error'})`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new VerificationError('redirect', `${check.name}: expected a direct response, received HTTP ${response.status} to ${response.headers.get('location') ?? 'an unspecified location'}`);
  }
  assert(response.status === check.status, 'status', `${check.name}: expected HTTP ${check.status}, received ${response.status}`);
  assert(bytes.length <= MAX_BODY_BYTES, 'body', `${check.name}: response exceeds the ${MAX_BODY_BYTES}-byte read limit`);
  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get('content-type') ?? '';
  if (check.contentType) {
    assert(contentType.includes(check.contentType), 'body', `${check.name}: expected content type ${check.contentType}, received "${contentType}"`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (check.verify) check.verify({ response, text, json, contentType, name: check.name });
}

// Runs every check and reports all failures rather than stopping at the first
// one, so a single run shows the whole picture.
export async function verifyService(service, { revision, origins = ORIGINS, fetchImpl = fetch, log = console.log } = {}) {
  const checks = service === 'cflab' ? primaryChecks(revision, origins) : analyticsChecks(revision, origins);
  const failures = [];
  for (const check of checks) {
    try {
      await runCheck(check, fetchImpl);
      log(`PASS  ${check.name}${check.note ? ` (${check.note})` : ''}`);
    } catch (error) {
      const category = error instanceof VerificationError ? error.category : 'network';
      const detail = `[${category}] ${error?.message ?? error}`;
      failures.push(detail);
      log(`FAIL  ${check.name}: ${detail}`);
    }
  }
  if (failures.length) {
    throw new VerificationError('checks', `${failures.length} of ${checks.length} production checks failed for ${service}:\n- ${failures.join('\n- ')}`);
  }
  log(`PASS: ${checks.length} read-only production checks passed for ${service}`);
}

function parseArgs(argv) {
  const options = { service: 'all', wait: false, origins: { ...ORIGINS } };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--service') { options.service = value; index += 1; }
    else if (flag === '--revision') { options.revision = value; index += 1; }
    else if (flag === '--primary') { options.origins.primary = value; index += 1; }
    else if (flag === '--analytics') { options.origins.analytics = value; index += 1; }
    else if (flag === '--cutover') { options.origins.cutover = value; index += 1; }
    else if (flag === '--wait') options.wait = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new VerificationError('status', `Unknown argument: ${flag}`);
  }
  if (!['cflab', 'analytics', 'all'].includes(options.service)) {
    throw new VerificationError('status', `--service must be cflab, analytics, or all (received ${options.service})`);
  }
  if (options.revision !== undefined && !REVISION_PATTERN.test(options.revision)) {
    throw new VerificationError('revision', `--revision is not a valid revision identifier: ${options.revision}`);
  }
  for (const key of Object.keys(options.origins)) {
    let url;
    try { url = new URL(options.origins[key]); } catch { throw new VerificationError('network', `--${key} is not a valid URL: ${options.origins[key]}`); }
    if (url.protocol !== 'https:') throw new VerificationError('network', `--${key} must use HTTPS: ${options.origins[key]}`);
    options.origins[key] = url.origin;
  }
  return options;
}

const USAGE = 'Usage: node scripts/verify-production.mjs [--service cflab|analytics|all] [--revision <sha>] [--wait] [--primary <origin>] [--analytics <origin>] [--cutover <origin>]';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const services = options.service === 'all' ? ['cflab', 'analytics'] : [options.service];
  const run = async () => {
    const failures = [];
    for (const service of services) {
      try {
        await verifyService(service, { revision: options.revision, origins: options.origins });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new VerificationError('checks', failures.map(error => error?.message ?? error).join('\n'));
    }
  };
  if (options.wait) await verifyUntilReady(run);
  else await run();
  console.log(`PASS: verified ${services.join(' and ')} production${options.revision ? ` at revision ${options.revision}` : ''}`);
}

// Importable for tests: the CLI only runs when this file is the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
