import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { CONSOLE_SCRIPT, consolePage } from '../../src/console/page.js';

const ORIGIN = 'http://localhost:8799';

function response(body, status = 200, contentType = 'application/json', headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => ({ 'content-type': contentType, ...headers })[String(name).toLowerCase()] ?? null },
    text: async () => text,
    blob: async () => text,
  };
}

function overview() {
  return {
    generated_at: '2026-10-26T16:00:00.000Z', caller: { email: 'admin@example.com', is_admin: true },
    revision: 'abc1234', summary: { projects: 5, active_projects: 5, users: 2, administrators: 1, sessions: 1, analytics_sites: 6, signals_observations: 319, databases: 3, jobs: 4 },
    health: { databases: [{ id: 'primary', label: 'cflab (primary)', reachable: true }, { id: 'analytics', label: 'cflab-analytics', reachable: true }] },
    warnings: [{ severity: 'warning', area: 'jobs', message: 'Bitcoin Signals daily treasury collection: Last attempt failed' }],
    activity: [
      { at: '2026-10-26T16:00:00.000Z', area: 'Bitcoin Signals', status: 'ok', summary: 'daily run: 53 observation(s) added' },
      { at: '2026-10-26T15:00:00.000Z', area: 'Identity', status: 'session', summary: 'Sign-in by admin@example.com' },
    ],
  };
}

function registry() {
  return {
    generated_at: '2026-10-26T16:00:00.000Z',
    services: [
      {
        id: 'cflab-core', name: 'CFLab core API', kind: 'worker', status: 'active',
        description: 'Shared identity and records.', worker: 'cflab', base_url: 'https://cflab.aismallbizguru.com', dashboard_path: '/',
        endpoints: [{ id: 'core-health', method: 'GET', path: '/api/health', access: 'public', summary: 'Liveness only.' }],
        resources: [{ id: 'db-primary', kind: 'database', reference: 'DB', detail: 'primary' }],
      },
      {
        id: 'wildlife-field-recorder', name: 'Wildlife <img src=x onerror=alert(1)>', kind: 'project', status: 'active',
        description: 'Field observations.', worker: 'cflab', base_url: null, dashboard_path: null,
        endpoints: [{ id: 'w1', method: 'GET', path: '/api/public/wildlife-safari/observations', access: 'public', summary: 'Approved only.' }],
        resources: [],
      },
    ],
    repositories: [{ id: 'cflab', name: 'aismallbizguru-cflab', url: 'git@github.com:x/y.git', branch: 'main', detail: 'Authoritative source.' }],
    jobs: [{ id: 'signals-hourly', service_id: 'bitcoin-signals', name: 'Hourly', schedule: '7 * * * *', description: 'x', active: true }],
    counts: { services: 2, endpoints: 2, resources: 1, repositories: 1, jobs: 1 },
  };
}

function databases() {
  return { databases: [
    { id: 'primary', label: 'cflab (primary)', binding: 'DB', migrations_dir: 'migrations', description: 'primary', reachable: true, tables: 13, indexes: 20, views: 0 },
    { id: 'analytics', label: 'cflab-analytics', binding: 'ANALYTICS', migrations_dir: 'migrations-analytics', description: 'analytics', reachable: true, tables: 8, indexes: 9, views: 0 },
  ] };
}

function schema() {
  return {
    generated_at: '2026-10-26T16:00:00.000Z',
    database: { id: 'primary', label: 'cflab (primary)', binding: 'DB', migrations_dir: 'migrations', description: 'primary' },
    tables: [{ name: 'users', columns: [{ name: 'email', type: 'TEXT', not_null: true, default_value: null, primary_key: 0 }], indexes: [{ name: 'users_email', table: 'users', unique: true, columns: ['email'] }] }],
    views: [],
  };
}

function jobs() {
  return { generated_at: '2026-10-26T16:00:00.000Z', jobs: [
    { id: 'signals-hourly', service_id: 'bitcoin-signals', name: 'Bitcoin Signals hourly market collection', schedule: '7 * * * *', schedule_timezone: 'UTC', description: 'Collects.', history_source: 'signals-collection', history_key: 'hourly', stale_after_minutes: 150, active: true, next_run_at: '2026-10-26T17:07:00.000Z', last_attempt: { started_at: '2026-10-26T16:07:30.000Z', finished_at: '2026-10-26T16:07:32.500Z', status: 'ok', detail: null }, last_success_at: '2026-10-26T16:07:30.000Z', last_failure: null, stale: false, history: 'recorded', warnings: [] },
    { id: 'backup-workflow', service_id: 'cflab-core', name: 'Backup workflow', schedule: '37 3 * * *', schedule_timezone: 'UTC', description: 'GitHub Actions.', history_source: 'external-workflow', history_key: null, stale_after_minutes: 1800, active: true, next_run_at: '2026-10-27T03:37:00.000Z', last_attempt: null, last_success_at: null, last_failure: null, stale: false, history: 'external', warnings: [] },
  ] };
}

function system() {
  return {
    generated_at: '2026-10-26T16:00:00.000Z', worker: 'cflab', revision: 'abc1234',
    bindings: [{ name: 'DB', type: 'D1', configured: true, purpose: 'Primary project database' }, { name: 'COINGECKO_DEMO_API_KEY', type: 'Secret', configured: true, purpose: 'CoinGecko' }],
    databases: databases().databases,
    backup: { recorded: true, checked_at: '2026-10-26T14:15:00.000Z', recorded_at: '2026-10-26T14:37:00.000Z', ok: true, max_age_hours: 30, age_hours: 1.8, stale: false },
    notes: ['Binding values are never returned.'],
  };
}

async function waitFor(check, label = 'condition') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function launch({ me = { user: { email: 'admin@example.com', is_admin: true } }, url = `${ORIGIN}/`, fail = [] } = {}) {
  const window = new Window({ url });
  const html = consolePage().replace(/<script>[\s\S]*<\/script>/, '');
  window.document.write(html);
  const calls = [];
  const bodies = [];
  window.sessionStorage.setItem('cflab_session', 'cflab-session');
  window.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(target, url).pathname;
    calls.push(`${method} ${path}`);
    if (fail.includes(path)) return response({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
    if (init.body) bodies.push({ path, body: JSON.parse(init.body) });
    if (path === '/api/auth/me') return me.status ? response(me.body, me.status) : response(me);
    if (path === '/api/admin/console/overview') return response(overview());
    if (path === '/api/auth/logout') return response({});
    if (path === '/api/admin/console/registry') return response(registry());
    if (path === '/api/admin/console/databases') return response(databases());
    if (path === '/api/admin/console/databases/primary/schema') return response(schema());
    if (path === '/api/admin/console/jobs') return response(jobs());
    if (path === '/api/admin/console/system') return response(system());
    if (path === '/api/admin/console/saved-queries') return response({ queries: [] });
    if (path.endsWith('/query')) {
      return response({
        database: { id: 'primary', label: 'cflab (primary)', binding: 'DB', migrations_dir: 'migrations', description: 'primary' },
        columns: ['email'], rows: [['admin@example.com']],
        metrics: { page: 1, page_size: 50, has_more: false, duration_ms: 4, sql_duration_ms: 1, rows_read: 2, rows_written: 0 },
      });
    }
    if (path.endsWith('/export')) return response('email\r\nadmin@example.com\r\n', 200, 'text/csv', { 'content-disposition': 'attachment; filename="cflab-primary.csv"' });
    return response({ error: { code: 'not_found', message: 'Route not found' } }, 404);
  };
  window.eval(CONSOLE_SCRIPT);
  return { window, document: window.document, calls, bodies, close: () => window.close() };
}

test('the console shell is accessible, responsive and free of external assets', () => {
  const html = consolePage();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>CFLab operations<\/title>/);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /role="tablist"/);
  for (const tab of ['overview', 'projects', 'databases', 'jobs', 'system']) {
    assert.match(html, new RegExp(`id="tabbtn-${tab}"`));
    assert.match(html, new RegExp(`id="tab-${tab}"`));
  }
  assert.doesNotMatch(html, /<script[^>]+src=/);
  // The only <link> is the inline SVG favicon; nothing external is loaded.
  assert.equal((html.match(/<link\b[^>]*>/g) || []).length, 1);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)[^>]+(?:src|href)="(?:https?:)?\/\//);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.match(html, /@media \(max-width:720px\)/);
});

test('every tab panel is a direct child of main so hiding one cannot hide another', () => {
  const window = new Window({ url: `${ORIGIN}/` });
  window.document.write(consolePage().replace(/<script>[\s\S]*<\/script>/, ''));
  const document = window.document;
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  assert.equal(panels.length, 5);
  for (const panel of panels) {
    assert.equal(panel.parentElement.id, 'main', `${panel.id} must be a sibling under main`);
    assert.equal(panel.querySelectorAll('[role="tabpanel"]').length, 0, `${panel.id} must not contain another panel`);
  }
  // Markup balance: an unclosed section would nest the later tabs inside an earlier one.
  const body = consolePage().slice(consolePage().indexOf('<body>'), consolePage().lastIndexOf('<script>'));
  assert.equal((body.match(/<section\b/g) || []).length, (body.match(/<\/section>/g) || []).length);
  window.close();
});

test('an anonymous visitor follows the existing sign-in flow', async () => {
  const app = launch({ me: { status: 401, body: { error: { code: 'unauthorized' } } } });
  await waitFor(() => app.window.location.href.includes('/admin/login'), 'redirect to sign in');
  assert.match(app.window.location.href, /\/admin\/login$/);
  assert.equal(app.document.getElementById('overview-cards').innerHTML, '');
  app.close();
});

test('a signed-in non-administrator is sent to the account page', async () => {
  const app = launch({ me: { user: { email: 'user@example.com', is_admin: false } } });
  await waitFor(() => app.window.location.href.includes('/account'), 'redirect to account');
  assert.match(app.window.location.href, /\/account$/);
  app.close();
});

test('the overview renders live summary, warnings and activity', async () => {
  const app = launch();
  await waitFor(() => app.document.getElementById('overview-cards').innerHTML.includes('319'), 'overview cards');
  const cards = app.document.getElementById('overview-cards').textContent;
  assert.match(cards, /Projects/);
  assert.match(cards, /319/);
  assert.match(app.document.getElementById('overview-warnings').textContent, /Last attempt failed/);
  assert.match(app.document.getElementById('activity').textContent, /Sign-in by admin@example.com/);
  assert.equal(app.document.getElementById('revision').textContent, 'revision abc1234');
  assert.match(app.document.getElementById('overview-health').textContent, /cflab \(primary\)/);
  assert.equal(app.document.getElementById('tab-overview').hidden, false);
  assert.equal(app.document.getElementById('tab-databases').hidden, true);
  app.close();
});


test('tabs load lazily, switch panels, and filter the project inventory', async () => {
  const app = launch();
  await waitFor(() => app.document.getElementById('overview-cards').innerHTML.length > 0, 'overview');
  assert.deepEqual(app.calls.filter(call => call.endsWith('/registry')), []);

  app.document.getElementById('tabbtn-projects').click();
  await waitFor(() => app.document.getElementById('projects-list').innerHTML.includes('CFLab core API'), 'projects');
  assert.equal(app.document.getElementById('tab-projects').hidden, false);
  assert.equal(app.document.getElementById('tab-overview').hidden, true);
  assert.equal(app.document.getElementById('tabbtn-projects').getAttribute('aria-selected'), 'true');
  assert.equal(app.calls.filter(call => call === 'GET /api/admin/console/registry').length, 1);

  // Untrusted registry text is escaped, never interpreted as markup.
  assert.equal(app.document.querySelectorAll('#projects-list img').length, 0);
  assert.match(app.document.getElementById('projects-list').innerHTML, /&lt;img/);

  const search = app.document.getElementById('project-search');
  search.value = 'wildlife';
  search.dispatchEvent(new app.window.Event('input'));
  assert.doesNotMatch(app.document.getElementById('projects-list').textContent, /CFLab core API/);
  assert.match(app.document.getElementById('projects-list').textContent, /Wildlife/);

  app.document.getElementById('tabbtn-jobs').click();
  await waitFor(() => app.document.getElementById('jobs').innerHTML.includes('Bitcoin Signals hourly'), 'jobs');
  assert.match(app.document.getElementById('jobs').textContent, /7 \* \* \* \*/);
  assert.match(app.document.getElementById('jobs').textContent, /workflow/);
  app.close();
});

test('the workbench runs a read-only query, pages, and never calls another origin', async () => {
  const app = launch();
  await waitFor(() => app.document.getElementById('overview-cards').innerHTML.length > 0, 'overview');
  app.document.getElementById('tabbtn-databases').click();
  await waitFor(() => app.document.getElementById('schema').innerHTML.includes('users'), 'schema');
  assert.equal(app.document.getElementById('db-select').value, 'primary');
  assert.match(app.document.getElementById('db-inventory').textContent, /primary reachable 13 tables/);

  app.document.getElementById('sql').value = 'SELECT email FROM users';
  app.document.getElementById('run').click();
  await waitFor(() => app.document.getElementById('db-results').textContent.includes('admin@example.com'), 'query results');
  const run = app.bodies.find(entry => entry.path.endsWith('/query'));
  assert.deepEqual(run.body, { sql: 'SELECT email FROM users', page: 1, page_size: 50 });
  assert.match(app.document.getElementById('db-metrics').textContent, /1 row\(s\)/);
  assert.match(app.document.getElementById('db-metrics').textContent, /database primary/);
  assert.equal(app.document.getElementById('next').hidden, false);
  assert.equal(app.document.getElementById('page-label').textContent, 'Page 1');
  assert.equal(app.document.getElementById('db-results').querySelectorAll('th').length, 1);

  // Selecting a table seeds the editor with a quoted, bounded statement.
  const tableButton = app.document.querySelector('#schema button[data-table]');
  assert.ok(tableButton);
  tableButton.click();
  assert.equal(app.document.getElementById('sql').value, 'SELECT * FROM "users" LIMIT 50');

  // Every request in this session stays on the console's own origin.
  for (const call of app.calls) assert.match(call, /^(GET|POST|DELETE) \/(api|$)/);
  app.close();
});

test('a failing section shows a visible error instead of a blank panel', async () => {
  const app = launch({ fail: ['/api/admin/console/jobs'] });
  await waitFor(() => app.document.getElementById('overview-cards').innerHTML.length > 0, 'overview');
  app.document.getElementById('tabbtn-jobs').click();
  await waitFor(() => app.document.getElementById('jobs').textContent.includes('Internal server error'), 'jobs error');
  assert.equal(app.document.getElementById('tab-jobs').hidden, false);
  assert.match(app.document.getElementById('jobs').innerHTML, /msg-error/);
  app.close();
});

test('the system tab shows presence and backup state without any secret value', async () => {
  const app = launch();
  await waitFor(() => app.document.getElementById('overview-cards').innerHTML.length > 0, 'overview');
  app.document.getElementById('tabbtn-system').click();
  await waitFor(() => app.document.getElementById('system').innerHTML.includes('COINGECKO_DEMO_API_KEY'), 'system');
  const text = app.document.getElementById('system').textContent;
  assert.match(text, /COINGECKO_DEMO_API_KEY/);
  assert.match(text, /configured/);
  assert.match(text, /fresh/);
  assert.match(app.document.getElementById('system-notes').textContent, /Binding values are never returned/);
  app.close();
});

