#!/usr/bin/env node
// Restore a D1 backup into an isolated database and verify it.
//
// This is what makes a backup *operational* rather than assumed: the export is
// loaded into a throwaway database, then its schema, row counts, SQLite quick
// check, and foreign keys are compared against the manifest.
//
// Two targets are supported:
//   * local (default) — an isolated local D1 under --work-dir, used by the
//     backup workflow on every run and by anyone verifying a backup offline;
//   * remote — an explicitly named, already-existing temporary database, which
//     requires --allow-remote-write. Production database names and ids are
//     refused outright, so this script cannot restore over production.
//
// It never deletes a backup, never writes to a production database, and never
// invokes Time Travel.
//
// Usage:
//   node scripts/backup/restore-verify.mjs --manifest <manifest.json> [--work-dir <dir>]
//   node scripts/backup/restore-verify.mjs --manifest <m.json> --remote-database <name> --allow-remote-write

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATABASES } from './d1-export.mjs';
import { sha256File, validateManifest, verifyArtifactAgainstManifest, wranglerResultSets, wranglerRows, writeJsonFile, canonicalRowHash } from './lib.mjs';

// Restoring over these would be a production incident, not a drill.
export const PRODUCTION_DATABASES = new Set([
  'cflab', 'cflab-analytics',
  'cb2d2eb4-2817-4581-8e50-d69212650adf', '54e8af8e-3345-40e7-88fd-462a688421b5',
]);

export function assertNotProductionTarget(target) {
  if (PRODUCTION_DATABASES.has(String(target).toLowerCase())) {
    throw new Error(`refusing to restore into the production database "${target}"; restore into a temporary database instead`);
  }
}

export function databaseFor(label) {
  const database = DATABASES.find(candidate => candidate.label === label);
  if (!database) throw new Error(`unknown database label "${label}"; expected one of ${DATABASES.map(d => d.label).join(', ')}`);
  return database;
}

function wranglerRun(args, { allowFailure = false } = {}) {
  const binary = path.join('node_modules', '.bin', 'wrangler');
  if (!existsSync(binary)) throw new Error(`wrangler is not installed at ${binary}; run npm ci first`);
  // Whole-table SELECTs (used for the row-hash comparison) exceed Node's 1 MiB
  // spawnSync default, so the cap is explicit and a truncated read fails loudly.
  const maxBuffer = 256 * 1024 * 1024;
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    const code = result.error.code ?? 'unknown';
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} could not be read (${code}${code === 'ENOBUFS' ? `: output exceeded the ${maxBuffer}-byte read buffer` : ''})`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (exit ${result.status ?? 'unknown'}):\n${output.trim()}`);
  }
  return { status: result.status ?? 1, output };
}

function query({ target, config, stateDir, sql, run }) {
  const args = ['d1', 'execute', target, '--config', config, '--json', '--command', sql];
  if (stateDir) args.push('--local', '--persist-to', stateDir);
  else args.push('--remote');
  return run(args);
}

export function verifyRestored({ target, config, stateDir, manifest, run = wranglerRun }) {
  const problems = [];
  const tables = wranglerRows(query({ target, config, stateDir, sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name", run }).output)
    .map(row => row.name).sort();

  const expectedTables = [...manifest.tables].sort();
  const missing = expectedTables.filter(table => !tables.includes(table));
  const extra = tables.filter(table => !expectedTables.includes(table));
  if (missing.length) problems.push(`restored database is missing tables: ${missing.join(', ')}`);
  if (extra.length) problems.push(`restored database has unexpected tables: ${extra.join(', ')}`);

  const shared = expectedTables.filter(table => tables.includes(table));
  const rowCounts = {};
  if (shared.length) {
    const countsSql = shared.map(table => `SELECT COUNT(*) AS n FROM "${table}"`).join('; ');
    const sets = wranglerResultSets(query({ target, config, stateDir, sql: countsSql, run }).output);
    shared.forEach((table, index) => { rowCounts[table] = Number(sets[index][0]?.n ?? 0); });
    for (const table of shared) {
      const expected = Number(manifest.row_counts?.[table] ?? 0);
      if (rowCounts[table] !== expected) problems.push(`restored "${table}" has ${rowCounts[table]} rows but the manifest records ${expected}`);
    }
  }

  const quick = wranglerRows(query({ target, config, stateDir, sql: 'PRAGMA quick_check', run }).output);
  const quickResult = String(quick[0]?.quick_check ?? 'unknown');
  if (quickResult !== 'ok') problems.push(`PRAGMA quick_check reported "${quickResult}"`);

  // When the manifest carries per-table row hashes, compare them: identical data
  // with different ordering must match, and any data difference must fail.
  if (manifest.row_hashes) {
    for (const table of shared) {
      if (!manifest.row_hashes[table]) continue;
      const rows = wranglerRows(query({ target, config, stateDir, sql: `SELECT * FROM "${table}"`, run }).output);
      const digest = canonicalRowHash(rows);
      if (digest !== manifest.row_hashes[table]) problems.push(`restored "${table}" does not reproduce the backed-up rows (row hash ${digest.slice(0, 12)}… vs ${manifest.row_hashes[table].slice(0, 12)}…)`);
    }
  }

  const foreignKeys = wranglerRows(query({ target, config, stateDir, sql: 'PRAGMA foreign_key_check', run }).output);
  if (foreignKeys.length) problems.push(`PRAGMA foreign_key_check reported ${foreignKeys.length} violation(s)`);

  return { ok: problems.length === 0, problems, tables, rowCounts, quickCheck: quickResult, foreignKeyViolations: foreignKeys.length };
}

export async function restoreAndVerify({ manifestPath, workDir = 'restore-drill', run = wranglerRun, remoteDatabase, remoteConfig, allowRemoteWrite = false }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestProblems = validateManifest(manifest);
  if (manifestProblems.length) throw new Error(`${manifestPath} is not a usable manifest:\n- ${manifestProblems.join('\n- ')}`);
  const database = databaseFor(manifest.database);
  const sqlPath = path.join(path.dirname(manifestPath), manifest.file);
  const artifactProblems = await verifyArtifactAgainstManifest(manifest, sqlPath);
  if (artifactProblems.length) throw new Error(`backup artifact failed verification:\n- ${artifactProblems.join('\n- ')}`);

  let target = database.binding;
  let config = database.localConfig;
  let stateDir;
  let mode = 'local';
  if (remoteDatabase) {
    if (!allowRemoteWrite) throw new Error('restoring into a remote database requires --allow-remote-write');
    assertNotProductionTarget(remoteDatabase);
    if (!remoteConfig) throw new Error('a remote restore needs --remote-config pointing at a config that declares the temporary database');
    target = remoteDatabase;
    config = remoteConfig;
    mode = 'remote';
  } else {
    stateDir = path.join(workDir, `restore-${manifest.database}-${manifest.stamp}`);
    mkdirSync(stateDir, { recursive: true });
  }

  const restoreArgs = ['d1', 'execute', target, '--config', config, '--file', sqlPath, '-y', ...(stateDir ? ['--local', '--persist-to', stateDir] : ['--remote'])];
  const startedAt = Date.now();
  const restore = run(restoreArgs, { allowFailure: true });
  const restoreMs = Date.now() - startedAt;
  if (restore.status !== 0) throw new Error(`restore failed (exit ${restore.status}):\n${restore.output.trim()}`);

  const verifyStartedAt = Date.now();
  const verification = verifyRestored({ target, config, stateDir, manifest, run });
  const verifyMs = Date.now() - verifyStartedAt;

  return {
    database: manifest.database, mode, target, stateDir, sqlPath, manifest,
    restore_ms: restoreMs, verify_ms: verifyMs,
    artifact_sha256: await sha256File(sqlPath),
    ...verification,
  };
}

function parseArgs(argv) {
  const options = { workDir: 'restore-drill' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--manifest') { options.manifestPath = value; index += 1; }
    else if (flag === '--work-dir') { options.workDir = value; index += 1; }
    else if (flag === '--report') { options.reportPath = value; index += 1; }
    else if (flag === '--remote-database') { options.remoteDatabase = value; index += 1; }
    else if (flag === '--remote-config') { options.remoteConfig = value; index += 1; }
    else if (flag === '--allow-remote-write') options.allowRemoteWrite = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

const USAGE = [
  'Usage: node scripts/backup/restore-verify.mjs --manifest <manifest.json> [--work-dir <dir>] [--report <file>]',
  '       node scripts/backup/restore-verify.mjs --manifest <m.json> --remote-database <name> --remote-config <config> --allow-remote-write',
].join('\n');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.manifestPath) throw new Error(`--manifest is required\n${USAGE}`);
  const result = await restoreAndVerify(options);
  const rows = Object.values(result.rowCounts).reduce((sum, count) => sum + count, 0);
  console.log(`OK    restored ${result.database} (${result.mode}${result.stateDir ? `, isolated state ${result.stateDir}` : `, target ${result.target}`})`);
  console.log(`      artifact sha256 ${result.artifact_sha256.slice(0, 16)}… verified against the manifest`);
  console.log(`      ${result.tables.length} tables, ${rows} rows, quick_check=${result.quickCheck}, foreign_key_violations=${result.foreignKeyViolations}`);
  console.log(`      restore ${result.restore_ms} ms, verification ${result.verify_ms} ms`);
  if (options.reportPath) writeJsonFile(options.reportPath, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
