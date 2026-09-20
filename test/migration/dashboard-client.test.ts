import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function clientPath(): string | null {
  const candidates = [
    process.env.DASHBOARD_CLIENT_PATH,
    new URL('../../../junkdrawer/analytics-dashboard.html', import.meta.url).pathname,
  ];
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? null;
}
const path = clientPath();
const html = path ? readFileSync(path, 'utf8') : '';

function extract(name: string): string {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return match[0];
}
const normalizeApiBase = path
  ? new Function('DEFAULT_API_BASE', `${extract('normalizeApiBase')}; return normalizeApiBase;`)('https://cflab.aismallbizguru.com/api') as (value: unknown) => string
  : null;

test('dashboard API base normalizes origins, trailing slashes, and defaults', { skip: !path }, () => {
  assert.equal(normalizeApiBase!('https://cflab.aismallbizguru.com'), 'https://cflab.aismallbizguru.com/api');
  assert.equal(normalizeApiBase!('https://cflab.aismallbizguru.com/api/'), 'https://cflab.aismallbizguru.com/api');
  assert.equal(normalizeApiBase!(''), 'https://cflab.aismallbizguru.com/api');
});

test('dashboard sign-in diagnostics distinguish failure classes', { skip: !path }, () => {
  assert.match(html, /Invalid email or password\./);
  assert.match(html, /Too many sign-in attempts/);
  assert.match(html, /rejected this browser origin/);
  assert.match(html, /Could not reach the CFLab backend/);
  assert.match(html, /sessionStorage\.setItem\("junkstats\.dashboard\.session"/);
  assert.doesNotMatch(html, /(?:^|[^a-z])lab\.aismallbizguru\.com\/api"/m);
});

test('dashboard origin migration is idempotent and seeds the dashboard app', () => {
  const migration = readFileSync(new URL('../../migrations/0007_junkstats_dashboard_origins.sql', import.meta.url), 'utf8');
  assert.match(migration, /INSERT OR IGNORE INTO apps/);
  assert.match(migration, /INSERT OR IGNORE INTO app_origins/);
  assert.ok(migration.includes("'junkstats-dashboard'"));
  assert.ok(migration.includes("'https://hmarquardt.github.io'"));
});
