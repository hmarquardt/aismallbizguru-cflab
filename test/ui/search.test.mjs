import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const INDEX_HTML = readFileSync(new URL('../../analytics-ui/index.html', import.meta.url), 'utf8');
const BODY = INDEX_HTML
  .slice(INDEX_HTML.indexOf('<body>') + 6, INDEX_HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const SITE = {
  id: 1, public_id: 'as_test', legacy_key: null, slug: 'fruitingforecast', name: 'Fruiting Forecast', timezone: 'UTC',
  active: true, respect_dnt: true, respect_gpc: true, raw_retention_days: 90, role: 'owner',
};
const DOMAINS = [{ id: 1, site_id: 1, hostname: 'fruitingforecast.com', kind: 'primary', active: 1 }];
const PROPERTY = 'sc-domain:fruitingforecast.com';

const STATUS = {
  site: 'as_test',
  configured: true,
  properties: [{
    property: PROPERTY, label: 'Fruiting Forecast', hostname: 'fruitingforecast.com',
    permission_level: 'siteRestrictedUser', mapped: true, active: true,
    last_attempt_at: '2026-10-27T12:00:00.000Z', last_success_at: '2026-10-27T12:00:00.000Z', last_error_code: null,
    newest_day: '2026-10-26', first_incomplete_day: '2026-10-25', days_covered: 37,
    backfill_cursor: '2026-09-19', backfill_complete: false,
  }],
  sync: { last_attempt_at: '2026-10-27T12:00:00.000Z', last_finished_at: '2026-10-27T12:00:01.000Z', last_success_at: '2026-10-27T12:00:01.000Z', last_error_code: null },
  freshness: { newest_reportable_day: '2026-10-26', newest_day: '2026-10-26', data_state: 'provisional', lag_days: 0 },
};

const SUMMARY = {
  site: 'as_test', property: PROPERTY, property_label: 'Fruiting Forecast', search_type: 'web',
  from: '2026-09-27', to: '2026-10-26',
  totals: { clicks: 9, impressions: 360, ctr: 0.025, position: 6.98, days: 3, provisional_days: 1 },
  previous: { from: '2026-08-28', to: '2026-09-26', clicks: 4, impressions: 200, ctr: 0.02, position: 8.4, days: 2, provisional_days: 0 },
  freshness: { covered_days: 3, requested_days: 30, missing_days: 27, newest_day: '2026-10-26', provisional_days: 1, last_success_at: '2026-10-27T12:00:00.000Z', first_incomplete_day: '2026-10-25', last_error_code: null },
};

const TIMESERIES = {
  site: 'as_test', property: PROPERTY, search_type: 'web', from: '2026-09-27', to: '2026-10-26',
  points: [
    { date: '2026-10-24', clicks: 1, impressions: 40, ctr: 0.025, position: 9.5, data_state: 'final' },
    { date: '2026-10-26', clicks: 5, impressions: 200, ctr: 0.025, position: 6.4, data_state: 'provisional' },
  ],
};

const QUERIES = {
  queries: [
    { query: 'fruiting forecast', clicks: 6, impressions: 150, ctr: 0.04, position: 3.67, days: 2 },
    { query: 'mushroom map', clicks: 1, impressions: 20, ctr: 0.05, position: 9, days: 1 },
  ],
};
const PAGES = { pages: [{ page: 'https://fruitingforecast.com/', clicks: 4, impressions: 100, ctr: 0.04, position: 3, days: 1 }] };
const BREAKDOWNS = {
  devices: [{ value: 'MOBILE', clicks: 6, impressions: 250, ctr: 0.024, position: 7, days: 2 }],
  countries: [{ value: 'USA', clicks: 5, impressions: 200, ctr: 0.025, position: 6.5, days: 2 }],
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function waitFor(predicate, message, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out: ${message}`);
}

function siteRoutes(options = {}) {
  const status = options.status === undefined ? STATUS : options.status;
  return {
    'GET /api/sites/as_test': () => ({ site: SITE, domains: DOMAINS, last_event_at_ms: 1758000000000 }),
    'GET /api/sites/as_test/search/status': () => status,
    'GET /api/sites/as_test/search/summary': () => options.summary || SUMMARY,
    'GET /api/sites/as_test/search/timeseries': () => TIMESERIES,
    'GET /api/sites/as_test/search/queries': () => QUERIES,
    'GET /api/sites/as_test/search/pages': () => PAGES,
    'GET /api/sites/as_test/search/breakdowns': () => BREAKDOWNS,
  };
}

async function launch({ url = 'http://localhost:8799/?site=as_test&tab=search', routes = {} } = {}) {
  const window = new Window({ url });
  const document = window.document;
  document.body.innerHTML = BODY;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'cflab-auth-base');
  meta.setAttribute('content', 'http://127.0.0.1:8787');
  document.head.append(meta);
  window.sessionStorage.setItem('cflab.analytics.token', 'cflab');

  const calls = [];
  const table = new Map(Object.entries({
    'GET /api/sites': () => ({ sites: [SITE] }),
    'GET /api/auth/me': () => ({ user: { email: 'admin@example.com', is_admin: true } }),
    ...siteRoutes(),
    ...routes,
  }));
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    const timer = originalSetInterval(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const resolved = new URL(raw, window.location.href);
    const method = (init.method || 'GET').toUpperCase();
    calls.push(`${method} ${resolved.pathname}${resolved.search}`);
    const handler = table.get(`${method} ${resolved.pathname}`) || table.get(`GET ${resolved.pathname}`);
    if (!handler) return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
    const result = await handler(resolved, init);
    if (result instanceof Response) return result;
    return jsonResponse(result && result.status ? result.status : 200, result && result.body !== undefined ? result.body : result);
  };

  globalThis.window = window;
  globalThis.document = document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'history', { value: window.history, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: window.sessionStorage, configurable: true, writable: true });
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle.bind(window) : () => ({ getPropertyValue: () => '' });

  class FakeChart {
    constructor(canvas, config) { FakeChart.instances.push(this); this.canvas = canvas; this.config = config; }
    destroy() { this.destroyed = true; }
  }
  FakeChart.instances = [];
  window.Chart = FakeChart;

  const moduleUrl = new URL('../../analytics-ui/analytics.js', import.meta.url).href + `?t=${Date.now()}-${Math.random()}`;
  await import(moduleUrl);

  return {
    window,
    document,
    calls,
    FakeChart,
    count: prefix => calls.filter(call => call.startsWith(prefix)).length,
    async close() {
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalSetInterval;
      try {
        if (window.happyDOM && typeof window.happyDOM.close === 'function') window.happyDOM.close();
        else window.close();
      } catch { /* already closed */ }
    },
  };
}

test('renders Search Console metrics, freshness, queries, pages and breakdowns', async () => {
  const app = await launch();
  try {
    await waitFor(() => app.document.querySelectorAll('#search-kpis .kpi').length === 4, 'search kpis');
    const values = [...app.document.querySelectorAll('#search-kpis .kpi-value')].map(node => node.textContent);
    assert.deepEqual(values, ['360', '9', '2.5%', '7.0']);
    const labels = [...app.document.querySelectorAll('#search-kpis .kpi-label')].map(node => node.textContent);
    assert.deepEqual(labels, ['Impressions', 'Clicks', 'CTR', 'Avg position']);

    // CTR and position carry honest deltas: percentage points and places.
    const deltas = [...app.document.querySelectorAll('#search-kpis .kpi-delta')].map(node => node.textContent);
    assert.equal(deltas[2], '+0.5 pp');
    assert.equal(deltas[3], '+1.4 places');

    assert.ok(app.document.getElementById('search-status').textContent.includes('siteRestrictedUser'));
    assert.ok(app.document.getElementById('search-status').textContent.includes('sc-domain:fruitingforecast.com'));
    assert.ok(app.document.getElementById('search-status-note').textContent.includes('provisional'));

    assert.ok(app.document.getElementById('search-queries').textContent.includes('fruiting forecast'));
    assert.ok(app.document.getElementById('search-queries').textContent.includes('6'));
    assert.ok(app.document.getElementById('search-pages').textContent.includes('https://fruitingforecast.com/'));
    assert.ok(app.document.getElementById('search-devices').textContent.includes('MOBILE'));
    assert.ok(app.document.getElementById('search-countries').textContent.includes('USA'));

    assert.ok(app.FakeChart.instances.length >= 1, 'chart rendered');
    const chart = app.FakeChart.instances.at(-1);
    assert.deepEqual(chart.config.data.datasets[0].data, [40, 200], 'impressions are plotted by default');
    assert.ok(app.document.getElementById('search-chart-table').textContent.includes('provisional'));

    const requested = app.calls.filter(call => call.includes('/search/'));
    assert.ok(requested.some(call => call.includes('property=sc-domain%3Afruitingforecast.com')), 'requests are property-scoped');
    assert.ok(app.calls.every(call => call.startsWith('GET /api/')), 'no third-party requests from the dashboard');
  } finally {
    await app.close();
  }
});

test('switches the search chart between impressions and clicks', async () => {
  const app = await launch();
  try {
    await waitFor(() => app.FakeChart.instances.length >= 1, 'chart rendered');
    const buttons = [...app.document.querySelectorAll('#search-metric-switch .segment')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Impressions', 'Clicks']);
    buttons[1].click();
    await waitFor(() => app.FakeChart.instances.at(-1).config.data.datasets[0].data[1] === 5, 'clicks plotted');
    assert.equal(app.document.querySelector('#search-metric-switch .segment[aria-pressed="true"]').textContent, 'Clicks');
  } finally {
    await app.close();
  }
});

test('offers a property selector when a Site has more than one property', async () => {
  const second = { ...STATUS.properties[0], property: 'https://fruitingforecast.com/', label: 'Fruiting Forecast (prefix)', permission_level: 'siteOwner' };
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/status': () => ({ ...STATUS, properties: [STATUS.properties[0], second] }),
  } });
  try {
    await waitFor(() => app.document.getElementById('search-property-control').hidden === false, 'property selector shown');
    const select = app.document.getElementById('search-property');
    assert.equal(select.options.length, 2);
    select.value = second.property;
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await waitFor(() => app.calls.some(call => call.includes('property=https%3A%2F%2Ffruitingforecast.com%2F')), 'selection scopes requests');
  } finally {
    await app.close();
  }
});

test('shows an explicit empty state when no property is mapped to the Site', async () => {
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/status': () => ({ ...STATUS, properties: [], configured: true, sync: { last_success_at: null } }),
  } });
  try {
    await waitFor(() => app.document.querySelector('#search-empty .state-title'), 'empty state');
    assert.equal(app.document.querySelector('#search-empty .state-title').textContent, 'No Search Console property is mapped to this Site');
    assert.equal(app.document.getElementById('search-data').hidden, true);
    assert.equal(app.count('GET /api/sites/as_test/search/summary'), 0, 'no report is requested without a property');
  } finally {
    await app.close();
  }
});

test('waits for the first synchronization instead of rendering zeros', async () => {
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/status': () => ({
      ...STATUS,
      sync: { last_attempt_at: null, last_finished_at: null, last_success_at: null, last_error_code: null },
      properties: [{ ...STATUS.properties[0], last_success_at: null, newest_day: null, days_covered: 0, backfill_complete: false }],
    }),
  } });
  try {
    await waitFor(() => app.document.querySelector('#search-empty .state-title'), 'not synced state');
    assert.equal(app.document.querySelector('#search-empty .state-title').textContent, 'Waiting for the first synchronization');
    assert.equal(app.document.getElementById('search-data').hidden, true);
    assert.equal(app.count('GET /api/sites/as_test/search/summary'), 0);
  } finally {
    await app.close();
  }
});

test('reports a missing server credential without leaking anything', async () => {
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/status': () => ({
      ...STATUS, configured: false,
      sync: { last_attempt_at: null, last_finished_at: null, last_success_at: null, last_error_code: null },
      properties: [{ ...STATUS.properties[0], last_success_at: null, newest_day: null, days_covered: 0 }],
    }),
  } });
  try {
    await waitFor(() => app.document.querySelector('#search-empty .state-title'), 'credential state');
    assert.equal(app.document.querySelector('#search-empty .state-title').textContent, 'Search Console credentials are not configured');
  } finally {
    await app.close();
  }
});

test('says no search traffic was reported rather than implying a failure', async () => {
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/summary': () => ({
      ...SUMMARY,
      totals: { clicks: 0, impressions: 0, ctr: 0, position: null, days: 7, provisional_days: 0 },
      previous: { from: '2026-08-28', to: '2026-09-26', clicks: 0, impressions: 0, ctr: 0, position: null, days: 0, provisional_days: 0 },
      freshness: { ...SUMMARY.freshness, covered_days: 7, missing_days: 23, provisional_days: 0 },
    }),
    'GET /api/sites/as_test/search/queries': () => ({ queries: [] }),
    'GET /api/sites/as_test/search/pages': () => ({ pages: [] }),
    'GET /api/sites/as_test/search/breakdowns': () => ({ devices: [], countries: [] }),
  } });
  try {
    await waitFor(() => app.document.querySelector('#search-empty .state-title'), 'no traffic state');
    assert.equal(app.document.querySelector('#search-empty .state-title').textContent, 'No search traffic reported for this period');
    assert.equal(app.document.getElementById('search-data').hidden, false, 'zero KPIs are still shown as reported values');
    const values = [...app.document.querySelectorAll('#search-kpis .kpi-value')].map(node => node.textContent);
    assert.deepEqual(values, ['0', '0', '0%', '—']);
    assert.ok(app.document.getElementById('search-queries').textContent.includes('Google reported no search traffic'));
  } finally {
    await app.close();
  }
});

test('shows a retryable error when the search summary fails', async () => {
  let failures = 1;
  const app = await launch({ routes: {
    'GET /api/sites/as_test/search/summary': () => {
      if (failures > 0) { failures -= 1; return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } }; }
      return SUMMARY;
    },
  } });
  try {
    await waitFor(() => app.document.querySelector('#search-kpis .state-error'), 'summary error');
    assert.ok(app.document.getElementById('search-kpis').textContent.includes('Retry'));
    const before = app.count('GET /api/sites/as_test/search/summary');
    app.document.querySelector('#search-kpis .state-error button').click();
    await waitFor(() => app.count('GET /api/sites/as_test/search/summary') > before, 'retry refetched');
    await waitFor(() => app.document.querySelectorAll('#search-kpis .kpi').length === 4, 'kpis after retry');
  } finally {
    await app.close();
  }
});

test('hides the hostname filter on Search and restores it on Overview', async () => {
  const app = await launch();
  try {
    await waitFor(() => app.document.querySelectorAll('#search-kpis .kpi').length === 4, 'search loaded');
    assert.equal(app.document.getElementById('domain-control').hidden, true);
    app.document.getElementById('tab-overview').click();
    await waitFor(() => app.document.getElementById('panel-overview').hidden === false, 'overview shown');
    assert.equal(app.document.getElementById('domain-control').hidden, false);
    // Let the overview requests settle before the window is torn down.
    await waitFor(
      () => app.document.querySelector('#kpi-grid .kpi, #kpi-grid .state-error') !== null,
      'overview settled',
    );
  } finally {
    await app.close();
  }
});
