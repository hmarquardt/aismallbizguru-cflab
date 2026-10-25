#!/usr/bin/env node
// Fail-closed D1 migration gate for the CFLab release pipeline.
//
// D1 applies every pending migration in a directory in filename order, so the
// pipeline must decide *before* it runs anything whether the pending set is safe
// to apply without an operator. This gate:
//
//   1. lists the pending migrations for all three databases with a read-only
//      `wrangler d1 migrations list --remote`;
//   2. classifies every pending file by reading its SQL;
//   3. blocks unless every file is confidently additive, or an explicit approval
//      recorded in .github/d1-migration-approvals.json matches the file's exact
//      SHA-256 (so editing an approved file invalidates its approval);
//   4. only then applies the pending migrations, and verifies none remain.
//
// It fails closed on anything it cannot prove: an unreadable migration list, a
// missing file, an unrecognized statement, an unreachable database, or a
// mismatched approval all stop the release with the operator action required.
// It never drops, resets, truncates, seeds, or mutates R2.
//
// Usage:
//   node scripts/ci/migration-gate.mjs [--apply] [--database DB|ANALYTICS|BTC_SIGNALS|all]
//   node scripts/ci/migration-gate.mjs --print-hash <migration-file>

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

export const DATABASES = [
  { name: 'DB', label: 'cflab (primary)', config: 'wrangler.jsonc', migrationsDir: 'migrations' },
  { name: 'ANALYTICS', label: 'cflab-analytics', config: 'wrangler.analytics.jsonc', migrationsDir: 'migrations-analytics' },
  { name: 'BTC_SIGNALS', label: 'cflab-bitcoin-signals', config: 'wrangler.jsonc', migrationsDir: 'migrations-bitcoin-signals' },
];

export const APPROVALS_PATH = '.github/d1-migration-approvals.json';

// Statements that change or destroy existing data, or change schema in a way an
// older Worker cannot read. These are never applied automatically.
const FORBIDDEN = [
  { pattern: /\bDROP\s+(TABLE|VIEW|TRIGGER|INDEX)\b/i, reason: 'drops a schema object' },
  { pattern: /\bALTER\s+TABLE\s+[^;]*?\bDROP\s+COLUMN\b/i, reason: 'drops a column' },
  { pattern: /\bALTER\s+TABLE\s+[^;]*?\bRENAME\b/i, reason: 'renames a table or column' },
  { pattern: /\bDELETE\s+FROM\b/i, reason: 'deletes rows' },
  { pattern: /\bTRUNCATE\b/i, reason: 'truncates a table' },
  { pattern: /\bUPDATE\s+[A-Za-z_]["\w]*\s+SET\b/i, reason: 'updates existing rows' },
  { pattern: /\bINSERT\s+OR\s+REPLACE\b/i, reason: 'replaces rows, which can remove existing data' },
  { pattern: /\bREPLACE\s+INTO\b/i, reason: 'replaces rows, which can remove existing data' },
  { pattern: /\bVACUUM\b/i, reason: 'rewrites the database' },
  { pattern: /\bPRAGMA\b/i, reason: 'changes database-level behavior' },
  { pattern: /\b(ATTACH|DETACH)\b/i, reason: 'attaches or detaches another database' },
];

// Single-pass scanner: removes -- and /* */ comments and splits on statement
// separators while respecting single-quoted string literals, so a comment can
// never hide a statement and a semicolon inside a literal never splits one.
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote) {
      current += character;
      if (character === "'") {
        if (next === "'") { current += next; index += 1; }
        else quote = false;
      }
      continue;
    }
    if (character === "'") { quote = true; current += character; continue; }
    if (character === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      current += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 1;
      current += ' ';
      continue;
    }
    if (character === ';') { statements.push(current); current = ''; continue; }
    current += character;
  }
  statements.push(current);
  return statements.map(statement => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function classifyStatement(statement) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(statement)) return { verdict: 'forbidden', reason: rule.reason };
  }
  if (/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s*\(/i.test(statement)) return { verdict: 'additive-safe' };
  if (/^CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s+ON\s+[^\s(]+\s*\(/i.test(statement)) return { verdict: 'additive-safe' };
  if (/^CREATE\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?[^\s(]+/i.test(statement)) return { verdict: 'additive-safe' };
  if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+[^\s(]+/i.test(statement)) return { verdict: 'additive-safe' };
  if (/^ALTER\s+TABLE\s+[^\s(]+\s+ADD\s+COLUMN\s+/i.test(statement)) {
    if (/\bUNIQUE\b/i.test(statement)) return { verdict: 'requires-approval', reason: 'adds a UNIQUE column' };
    if (/\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) return { verdict: 'requires-approval', reason: 'adds a NOT NULL column without a default' };
    return { verdict: 'additive-safe' };
  }
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement)) return { verdict: 'requires-approval', reason: 'creates a unique index, which can fail on existing data' };
  if (/^CREATE\s+TRIGGER\b/i.test(statement)) return { verdict: 'requires-approval', reason: 'creates a trigger with side effects' };
  return { verdict: 'requires-approval', reason: 'statement is not recognized as additive' };
}

export function classifyMigration(sql) {
  const statements = splitStatements(sql);
  if (!statements.length) return { verdict: 'requires-approval', reasons: ['migration contains no statements'] };
  const reasons = [];
  let verdict = 'additive-safe';
  for (const statement of statements) {
    const classification = classifyStatement(statement);
    if (classification.verdict === 'forbidden') return { verdict: 'forbidden', reasons: [classification.reason] };
    if (classification.verdict === 'requires-approval') {
      verdict = 'requires-approval';
      reasons.push(classification.reason);
    }
  }
  return { verdict, reasons };
}

// Reads `wrangler d1 migrations list --remote` output. It fails closed rather
// than guessing: an unparseable list stops the release.
export function parsePendingMigrations(output) {
  if (/No migrations to apply/i.test(output)) return [];
  const marker = 'Migrations to be applied:';
  const markerIndex = output.indexOf(marker);
  if (markerIndex === -1) {
    throw new GateError(`Could not find the pending migration list in the wrangler output:\n${output.trim()}`);
  }
  const pending = [];
  for (const rawLine of output.slice(markerIndex + marker.length).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[┌├└─┬┴┼│|]+$/.test(line)) continue;
    const row = /^[│|]\s*([^\s│|]+\.sql)\s*[│|]\s*$/.exec(line);
    if (row) { pending.push(row[1]); continue; }
    if (/\.sql/i.test(line)) throw new GateError(`Unexpected line in the pending migration table: ${line}`);
  }
  return pending;
}

export function loadApprovals(path = APPROVALS_PATH) {
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new GateError(`${path} is not valid JSON: ${error.message}`);
  }
  const approved = parsed?.approved;
  if (!Array.isArray(approved)) throw new GateError(`${path} must contain an "approved" array`);
  for (const entry of approved) {
    if (!entry?.database || !entry?.file || !entry?.sha256) {
      throw new GateError(`${path}: every approval needs "database", "file", and "sha256"`);
    }
  }
  return approved;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// D1 Time Travel bookmarks are the recovery mechanism for a bad migration. The
// gate records the bookmark before and after applying so an operator has the
// exact point-in-time to restore. Reading a bookmark never changes a database.
export function parseBookmark(output) {
  const match = /\bcurrent bookmark is '([0-9a-fA-F-]{8,})'/i.exec(output);
  return match ? match[1] : null;
}

function readBookmark(env, db) {
  const result = wrangler(['d1', 'time-travel', 'info', db.name, '--config', db.config], env);
  return result.status === 0 ? parseBookmark(result.output) : null;
}

// Decides whether the pending set may be applied without an operator. An
// approval only counts when it names the exact file content, so editing an
// approved migration invalidates the approval.
export function evaluatePending({ database, pending, migrationsDir, approvals, readFile = path => readFileSync(path, 'utf8') }) {
  const entries = [];
  for (const file of pending) {
    const migrationPath = path.join(migrationsDir, file);
    let sql;
    try {
      sql = readFile(migrationPath);
    } catch {
      entries.push({ file, verdict: 'missing', reasons: [`${migrationPath} is not present in this checkout`], sha256: null, approved: false });
      continue;
    }
    const classification = classifyMigration(sql);
    const digest = sha256(sql);
    const approval = approvals.find(entry => entry.database === database && entry.file === file && entry.sha256 === digest);
    entries.push({ file, ...classification, sha256: digest, approved: classification.verdict !== 'additive-safe' && Boolean(approval), approvalReason: approval?.reason });
  }
  const blocked = entries.filter(entry => entry.verdict !== 'additive-safe' && !entry.approved);
  return { entries, blocked };
}

function wrangler(args, env) {
  const binary = path.join('node_modules', '.bin', 'wrangler');
  if (!existsSync(binary)) throw new GateError(`wrangler is not installed at ${binary}; run npm ci first`);
  const result = spawnSync(binary, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw new GateError(`Could not run wrangler: ${result.error.message}`);
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function d1Environment() {
  const token = process.env.CLOUDFLARE_D1_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new GateError('No D1 credential is available for this step: set CLOUDFLARE_D1_API_TOKEN (or CLOUDFLARE_API_TOKEN)');
  }
  return { ...process.env, CLOUDFLARE_API_TOKEN: token };
}

function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function parseArgs(argv) {
  const options = { apply: false, database: 'all', approvalsPath: APPROVALS_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--database') { options.database = value; index += 1; }
    else if (flag === '--approvals') { options.approvalsPath = value; index += 1; }
    else if (flag === '--print-hash') { options.printHash = value; index += 1; }
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new GateError(`Unknown argument: ${flag}`);
  }
  return options;
}

const USAGE = 'Usage: node scripts/ci/migration-gate.mjs [--apply] [--database DB|ANALYTICS|BTC_SIGNALS|all] [--approvals <path>]\n       node scripts/ci/migration-gate.mjs --print-hash <migration-file>';

function blockedMessage(database, blocked) {
  const db = DATABASES.find(candidate => candidate.name === database);
  return [
    `Blocked: ${blocked.length} pending migration(s) for ${db.label} (${db.name}) cannot be applied automatically.`,
    ...blocked.map(entry => `  ${entry.file}: ${entry.verdict} - ${entry.reasons.join('; ')}`),
    '',
    'Operator action (the release stays blocked until this is resolved):',
    `  1. Review ${db.migrationsDir}/${blocked[0].file} and every other blocked file: confirm the change preserves existing rows and stays readable by the currently deployed Worker.`,
    `  2. Record the exact content hash: node scripts/ci/migration-gate.mjs --print-hash ${db.migrationsDir}/<file>`,
    `  3. Add an entry to ${APPROVALS_PATH} with "database": "${db.name}", "file", "sha256", "reason", "approved_by", and "approved_at", then merge it. Editing an approved file invalidates its approval.`,
    `  4. Or apply it deliberately and re-run this pipeline: CLOUDFLARE_API_TOKEN=$CLOUDFLARE_D1_API_TOKEN npx wrangler d1 migrations apply ${db.name} --remote --config ${db.config}`,
    '     Record the Time Travel bookmark first and verify production afterwards (docs/CI-CD.md#d1-recovery); releases normally come from GitHub Actions.',
    '  D1 captures a backup before applying and rolls back a failed migration, so a blocked migration leaves the database unchanged.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.printHash) {
    console.log(`${sha256(readFileSync(options.printHash, 'utf8'))}  ${options.printHash}`);
    return;
  }
  const selected = DATABASES.filter(db => options.database === 'all' || db.name === options.database);
  if (!selected.length) throw new GateError(`--database must be one of ${DATABASES.map(db => db.name).join(', ')}, or all`);
  const approvals = loadApprovals(options.approvalsPath);
  const env = d1Environment();
  const summary = ['## D1 migration gate', ''];

  for (const db of selected) {
    const listed = wrangler(['d1', 'migrations', 'list', db.name, '--remote', '--config', db.config], env);
    if (listed.status !== 0) {
      throw new GateError(`Could not read pending migrations for ${db.label} (${db.name}). The gate fails closed:\n${listed.output.trim()}`);
    }
    const pending = parsePendingMigrations(listed.output);
    if (!pending.length) {
      console.log(`OK    ${db.label} (${db.name}): no pending migrations`);
      summary.push(`- ${db.label} (\`${db.name}\`): no pending migrations`);
      continue;
    }
    const { entries, blocked } = evaluatePending({ database: db.name, pending, migrationsDir: db.migrationsDir, approvals });
    for (const entry of entries) {
      const state = entry.verdict === 'additive-safe' ? 'SAFE' : entry.approved ? 'APPROVED' : 'BLOCKED';
      const detail = entry.verdict === 'additive-safe' ? '' : ` - ${entry.reasons.join('; ')}`;
      console.log(`${state.padEnd(8)} ${db.name} ${entry.file}: ${entry.verdict}${detail}`);
    }
    if (blocked.length) throw new GateError(blockedMessage(db.name, blocked));
    if (!options.apply) {
      console.log(`CHECK ${db.label} (${db.name}): ${entries.length} additive migration(s) would be applied; re-run with --apply to apply them`);
      summary.push(`- ${db.label} (\`${db.name}\`): ${entries.length} additive migration(s) ready (check only)`);
      continue;
    }
    // Record the recovery point before changing anything. This is best-effort
    // metadata: a failed bookmark read must not block an otherwise safe release.
    const bookmarkBefore = readBookmark(env, db);
    console.log(bookmarkBefore
      ? `BOOKMARK ${db.name} before applying: ${bookmarkBefore}`
      : `WARN  ${db.name}: no Time Travel bookmark was reported before applying`);
    const applied = wrangler(['d1', 'migrations', 'apply', db.name, '--remote', '--config', db.config], env);
    if (applied.status !== 0) throw new GateError(`Applying migrations for ${db.label} (${db.name}) failed:\n${applied.output.trim()}`);
    const after = wrangler(['d1', 'migrations', 'list', db.name, '--remote', '--config', db.config], env);
    if (after.status !== 0) throw new GateError(`Could not confirm the migration state for ${db.label} (${db.name}):\n${after.output.trim()}`);
    const remaining = parsePendingMigrations(after.output);
    if (remaining.length) throw new GateError(`Migrations are still pending for ${db.label} (${db.name}) after applying: ${remaining.join(', ')}`);
    const approvedCount = entries.filter(entry => entry.approved).length;
    const bookmarkAfter = readBookmark(env, db);
    console.log(`OK    ${db.label} (${db.name}): applied ${entries.length} migration(s)${approvedCount ? ` (${approvedCount} with an operator approval)` : ''} and confirmed none remain pending`);
    if (bookmarkAfter) console.log(`BOOKMARK ${db.name} after applying: ${bookmarkAfter}`);
    summary.push(`- ${db.label} (\`${db.name}\`): applied ${entries.length} migration(s)${approvedCount ? ` (${approvedCount} approved)` : ''}: ${entries.map(entry => entry.file).join(', ')}`);
    summary.push(bookmarkBefore
      ? `  - pre-migration Time Travel bookmark: \`${bookmarkBefore}\` (undo with \`npx wrangler d1 time-travel restore ${db.name} --config ${db.config} --bookmark=${bookmarkBefore}\`)`
      : '  - no pre-migration Time Travel bookmark was reported; check the Cloudflare dashboard before relying on a restore');
  }
  writeSummary(summary);
}

// Importable for tests: the CLI only runs when this file is the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    writeSummary(['## D1 migration gate', '', `FAILED: ${error?.message ?? error}`]);
    process.exitCode = 1;
  }
}
