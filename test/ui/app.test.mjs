import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { rangeFor } from '../../analytics-ui/lib.js';

const INDEX_HTML = readFileSync(new URL('../../analytics-ui/index.html', import.meta.url), 'utf8');
const BODY = INDEX_HTML
  .slice(INDEX_HTML.indexOf('<body>') + 6, INDEX_HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const SITE = {
  id: 1, public_id: 'as_test', legacy_key: null, slug: 'test', name: 'Test Site', timezone: 'UTC',
  active: true, respect_dnt: true, respect_gpc: true, raw_retention_days: 90, role: 'owner',
};
const DOMAINS = [
  { id: 1, site_id: 1, hostname: 'example.com', kind: 'primary', active: 1 },
  { id: 2, site_id: 1, hostname: 'www.example.com', kind: 'alias', active: 1 },
];
const SUMMARY = { site: 'as_test', from: '', to: '', domain: null, pageviews: 12481, events: 314, sessions: 8204, pages_per_session: 1.52, bounce_rate: 0.4 };
const PREVIOUS = { ...SUMMARY, pageviews: 10000, sessions: 8000, events: 314, pages_per_session: 1.5 };
const LONG_PATH = '/a-very-long-page-path-that-should-truncate-in-the-ui-with-more-segments';
const SNIPPET = '<script defer src="https://analytics.aismallbizguru.com/script.js" data-site="as_test"></script>';

function siteRoutes(ref, options = {}) {
  const summary = options.summary || SUMMARY;
  const previous = options.previous || PREVIOUS;
  let summaryCalls = 0;
  return {
    [`GET /api/sites/${ref}`]: () => ({
      site: { ...SITE, public_id: ref, name: options.name || 'Test Site', role: options.role || 'owner' },
      domains: options.domains || DOMAINS,
      last_event_at_ms: options.lastEventAt === undefined ? 1758000000000 : options.lastEventAt,
    }),
    [`GET /api/sites/${ref}/summary`]: () => (++summaryCalls === 1 ? summary : previous),
    [`GET /api/sites/${ref}/timeseries`]: () => ({
      bucket: 'day',
      points: [
        { date: '2026-09-19', pageviews: 100, sessions: 50, events: 2 },
        { date: '2026-09-20', pageviews: 120, sessions: 60, events: 3 },
      ],
    }),
    [`GET /api/sites/${ref}/pages`]: () => ({ pages: [{ pathname: LONG_PATH, pageviews: 100, sessions: 50 }, { pathname: '/b', pageviews: 40, sessions: 20 }] }),
    [`GET /api/sites/${ref}/referrers`]: () => ({ referrers: [{ referrer: 'direct', pageviews: 80, sessions: 40 }, { referrer: 'long-referrer-hostname.example.com', pageviews: 20, sessions: 10 }] }),
    [`GET /api/sites/${ref}/devices`]: () => ({
      devices: [{ value: 'desktop', pageviews: 90, sessions: 45 }, { value: 'mobile', pageviews: 30, sessions: 15 }],
      browsers: [{ value: 'Chrome', pageviews: 80, sessions: 40 }],
      operating_systems: [{ value: 'macOS', pageviews: 70, sessions: 35 }],
    }),
    [`GET /api/sites/${ref}/recent`]: () => ({
      events: [{ received_at_ms: 1758000000000, event_kind: 'pageview', event_name: 'pageview', pathname: '/a', referrer_host: 'direct', browser: 'Chrome', device: 'desktop', country_code: 'US' }],
    }),
    [`GET /api/sites/${ref}/live`]: () => ({ events: 2, pageviews: 2, sessions: 1, pages: [{ pathname: '/a', events: 2 }] }),
    [`GET /api/sites/${ref}/snippet`]: () => ({ snippet: SNIPPET, site: ref, endpoint: 'https://analytics.aismallbizguru.com/collect' }),
    [`GET /api/sites/${ref}/members`]: () => ({ members: [] }),
  };
}

function jsonResponse(status, body) {
  if (status === 204) return new Response(null, { status });
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

async function launch({ url = 'http://localhost:8799/', token = null, routes = {} } = {}) {
  const window = new Window({ url });
  const document = window.document;
  document.body.innerHTML = BODY;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'cflab-auth-base');
  meta.setAttribute('content', 'http://127.0.0.1:8787');
  document.head.append(meta);
  if (token) window.sessionStorage.setItem('cflab.analytics.token', token);

  const calls = [];
  const table = new Map(Object.entries(routes));
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

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
  globalThis.setInterval = (fn, ms) => {
    const timer = originalSetInterval(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  globalThis.clearInterval = originalClearInterval;

  globalThis.window = window;
  globalThis.document = document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'history', { value: window.history, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: window.sessionStorage, configurable: true, writable: true });
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle.bind(window)
    : () => ({ getPropertyValue: () => '' });

  class FakeChart {
    constructor(canvas, config) {
      FakeChart.instances.push(this);
      this.canvas = canvas;
      this.config = config;
      this.destroyed = false;
    }
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
      let last = -1;
      for (let index = 0; index < 15; index += 1) {
        if (calls.length === last) break;
        last = calls.length;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      try {
        if (window.happyDOM && typeof window.happyDOM.close === 'function') window.happyDOM.close();
        else window.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const baseRoutes = {
  'GET /api/sites': () => ({ sites: [SITE] }),
  'GET /api/auth/me': () => ({ user: { email: 'admin@example.com', is_admin: true } }),
  ...siteRoutes('as_test'),
};

test('shows the login screen when there is no session', async () => {
  const app = await launch({ routes: baseRoutes });
  try {
    assert.equal(app.document.getElementById('login-view').hidden, false);
    assert.equal(app.document.getElementById('app-view').hidden, true);
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('reports invalid credentials without entering the app', async () => {
  const app = await launch({
    routes: {
      ...baseRoutes,
      'POST /api/auth/login': () => ({ status: 401, body: { error: { code: 'invalid_credentials', message: 'Invalid email or password' } } }),
    },
  });
  try {
    app.document.getElementById('login-email').value = 'admin@example.com';
    app.document.getElementById('login-password').value = 'wrong-password';
    app.document.getElementById('login-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.getElementById('login-error').textContent.includes('Invalid email or password'), 'login error shown');
    assert.equal(app.document.getElementById('app-view').hidden, true);
  } finally {
    await app.close();
  }
});

test('signs in and renders the overview with real metrics, chart, and lists', async () => {
  const app = await launch({
    routes: {
      ...baseRoutes,
      'POST /api/auth/login': () => ({ token: 'cflu_' + 'a'.repeat(64), token_type: 'Bearer' }),
    },
  });
  try {
    app.document.getElementById('login-email').value = 'admin@example.com';
    app.document.getElementById('login-password').value = 'a-valid-password-123';
    app.document.getElementById('login-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'kpis rendered');
    assert.equal(app.document.getElementById('app-view').hidden, false);
    assert.equal(app.document.querySelectorAll('.kpi-value')[0].textContent, '12,481');
    assert.equal(app.document.querySelector('.kpi-delta.is-up').textContent, '+24.8%');
    assert.equal(app.document.querySelectorAll('#tabs .tab').length, 5);
    assert.equal(app.document.getElementById('account-email').textContent, 'admin@example.com');
    assert.ok(app.FakeChart.instances.length >= 1, 'line chart created');
    assert.equal(app.FakeChart.instances[0].config.type, 'line');
    assert.ok(app.document.getElementById('overview-pages').textContent.includes(LONG_PATH));
    assert.ok(app.document.getElementById('live-stats').textContent.includes('1 active sessions'));
    assert.ok(app.count('GET /api/sites/as_test/summary') === 2, 'current and previous summary requested');
  } finally {
    await app.close();
  }
});

test('switches tabs lazily without refetching the overview', async () => {
  const app = await launch({ token: 'cflab', routes: baseRoutes });
  try {
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'overview loaded');
    const summaryCalls = app.count('GET /api/sites/as_test/summary');

    app.document.getElementById('tab-pages').click();
    await waitFor(() => app.document.querySelector('#pages-table .data-table'), 'pages table');
    assert.equal(app.document.getElementById('panel-pages').hidden, false);
    assert.equal(app.document.getElementById('panel-overview').hidden, true);
    assert.equal(app.calls.filter(call => call.startsWith('GET /api/sites/as_test/pages') && call.includes('limit=50')).length, 1);
    assert.equal(app.count('GET /api/sites/as_test/summary'), summaryCalls);

    app.document.getElementById('tab-acquisition').click();
    await waitFor(() => app.document.querySelector('#acquisition-referrers .bars'), 'referrers rendered');
    assert.equal(app.calls.filter(call => call.startsWith('GET /api/sites/as_test/referrers') && call.includes('limit=20')).length, 1);

    app.document.getElementById('tab-events').click();
    await waitFor(() => app.document.querySelector('#events-table .state-block, #events-table .data-table'), 'events rendered');
    assert.equal(app.count('GET /api/sites/as_test/recent') >= 1, true);
  } finally {
    await app.close();
  }
});

test('switching sites reloads reports for the selected site', async () => {
  const otherSite = { ...SITE, public_id: 'as_other', name: 'Other Site' };
  const app = await launch({
    token: 'cflab',
    routes: {
      'GET /api/sites': () => ({ sites: [SITE, otherSite] }),
      'GET /api/auth/me': () => ({ user: { email: 'admin@example.com', is_admin: true } }),
      ...siteRoutes('as_test'),
      ...siteRoutes('as_other', { summary: { ...SUMMARY, pageviews: 77, sessions: 20, events: 1 }, previous: { ...PREVIOUS, pageviews: 70, sessions: 18, events: 1 } }),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'overview loaded');
    const select = app.document.getElementById('site-select');
    select.value = 'as_other';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await waitFor(() => app.count('GET /api/sites/as_other/summary') === 2, 'other site summary');
    await waitFor(() => app.document.querySelectorAll('.kpi-value')[0].textContent === '77', 'other kpis');
    assert.equal(app.document.getElementById('site-select').value, 'as_other');
    assert.ok(app.calls.some(call => call.startsWith('GET /api/sites/as_other/timeseries')));
  } finally {
    await app.close();
  }
});

test('domain filter is available in the header and scopes report requests', async () => {
  const app = await launch({ token: 'cflab', routes: baseRoutes });
  try {
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'overview loaded');
    const options = [...app.document.getElementById('domain-select').options].map(option => option.textContent);
    assert.deepEqual(options, ['All domains', 'example.com', 'www.example.com']);

    const select = app.document.getElementById('domain-select');
    select.value = 'example.com';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await waitFor(() => app.calls.some(call => call.includes('GET /api/sites/as_test/summary') && call.includes('domain=example.com')), 'domain filtered summary');
    assert.equal(app.count('GET /api/sites/as_test/summary'), 4, 'summary refetched for both periods');
  } finally {
    await app.close();
  }
});

test('date range switching uses the right window and bucket', async () => {
  const app = await launch({ token: 'cflab', routes: baseRoutes });
  try {
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'overview loaded');
    const select = app.document.getElementById('range-select');
    select.value = '7d';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    const week = rangeFor('7d');
    await waitFor(() => app.calls.some(call => call.includes(`GET /api/sites/as_test/timeseries`) && call.includes(`from=${week.from}`) && call.includes('bucket=day')), 'weekly timeseries');

    select.value = 'today';
    select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    const today = rangeFor('today');
    await waitFor(() => app.calls.some(call => call.includes('GET /api/sites/as_test/timeseries') && call.includes(`from=${today.from}`) && call.includes('bucket=hour')), 'hourly timeseries');
  } finally {
    await app.close();
  }
});

test('shows a retryable error when a report fails', async () => {
  const app = await launch({
    token: 'cflab',
    routes: {
      ...baseRoutes,
      'GET /api/sites/as_test/summary': () => ({ status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } }),
    },
  });
  try {
    await waitFor(() => app.document.querySelector('#kpi-grid .state-error'), 'error state');
    assert.ok(app.document.getElementById('kpi-grid').textContent.includes('Retry'));
    const before = app.count('GET /api/sites/as_test/summary');
    app.document.querySelector('#kpi-grid .state-error button').click();
    await waitFor(() => app.count('GET /api/sites/as_test/summary') > before, 'retry refetched');
  } finally {
    await app.close();
  }
});

test('shows an intentional empty state and links to setup', async () => {
  const app = await launch({
    token: 'cflab',
    routes: {
      ...baseRoutes,
      ...siteRoutes('as_test', {
        lastEventAt: null,
        summary: { ...SUMMARY, pageviews: 0, sessions: 0, events: 0, pages_per_session: 0 },
        previous: { ...PREVIOUS, pageviews: 0, sessions: 0, events: 0 },
      }),
    },
  });
  try {
    await waitFor(() => app.document.querySelector('#overview-empty .state-title'), 'empty state');
    assert.equal(app.document.querySelector('#overview-empty .state-title').textContent, 'No analytics yet');
    assert.equal(app.document.getElementById('overview-content').hidden, true);
    const setup = [...app.document.querySelectorAll('#overview-empty button')].find(button => button.textContent === 'View setup');
    setup.click();
    await waitFor(() => app.document.getElementById('panel-settings').hidden === false, 'settings panel shown');
    assert.equal(app.document.getElementById('panel-overview').hidden, true);
  } finally {
    await app.close();
  }
});

test('returns to sign-in when the session expires', async () => {
  const app = await launch({
    token: 'expired',
    routes: {
      ...baseRoutes,
      'GET /api/sites': () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Invalid or expired session' } } }),
    },
  });
  try {
    await waitFor(() => app.document.getElementById('login-error').textContent.includes('session has expired'), 'expiry message');
    assert.equal(app.document.getElementById('app-view').hidden, true);
    assert.equal(app.document.getElementById('login-view').hidden, false);
  } finally {
    await app.close();
  }
});

test('settings loads the snippet and copies it with feedback', async () => {
  const app = await launch({ token: 'cflab', routes: baseRoutes });
  try {
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'overview loaded');
    const copied = [];
    Object.defineProperty(app.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { copied.push(text); } },
    });
    app.document.getElementById('tab-settings').click();
    await waitFor(() => app.document.getElementById('snippet').textContent.includes('data-site="as_test"'), 'snippet loaded');
    assert.equal(app.document.getElementById('panel-settings').hidden, false);
    assert.equal(app.document.getElementById('site-name').value, 'Test Site');
    assert.equal(app.document.getElementById('domain-list').textContent.includes('example.com'), true);

    app.document.getElementById('copy-snippet').click();
    await waitFor(() => copied.length === 1, 'snippet copied');
    assert.equal(copied[0], SNIPPET);
    assert.equal(app.document.getElementById('copy-snippet').textContent, 'Copied');
    assert.equal(app.document.getElementById('snippet-note').textContent, 'Snippet copied to clipboard');
  } finally {
    await app.close();
  }
});

test('renders skeletons while a report request is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await launch({
    token: 'cflab',
    routes: {
      ...baseRoutes,
      'GET /api/sites/as_test/summary': async () => {
        await gate;
        return SUMMARY;
      },
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#kpi-grid .skeleton').length === 4, 'kpi skeletons');
    assert.equal(app.document.getElementById('kpi-grid').getAttribute('aria-busy'), 'true');
    release();
    await waitFor(() => app.document.querySelectorAll('.kpi').length === 4, 'kpis after release');
    assert.equal(app.document.getElementById('kpi-grid').getAttribute('aria-busy'), null);
  } finally {
    await app.close();
  }
});

test('restores site, domain, range, and tab from the URL', async () => {
  const otherSite = { ...SITE, public_id: 'as_other', name: 'Other Site' };
  const app = await launch({
    token: 'cflab',
    url: 'http://localhost:8799/?site=as_other&domain=example.com&range=7d&tab=pages',
    routes: {
      'GET /api/sites': () => ({ sites: [SITE, otherSite] }),
      'GET /api/auth/me': () => ({ user: { email: 'admin@example.com', is_admin: true } }),
      ...siteRoutes('as_test'),
      ...siteRoutes('as_other'),
    },
  });
  try {
    await waitFor(() => app.document.querySelector('#pages-table .data-table'), 'pages from url');
    assert.equal(app.document.getElementById('site-select').value, 'as_other');
    assert.equal(app.document.getElementById('domain-select').value, 'example.com');
    assert.equal(app.document.getElementById('range-select').value, '7d');
    assert.equal(app.document.getElementById('panel-pages').hidden, false);
    const week = rangeFor('7d');
    assert.ok(app.calls.some(call => call.includes('GET /api/sites/as_other/pages') && call.includes('domain=example.com') && call.includes(`from=${week.from}`)));
    assert.ok(app.window.location.search.includes('site=as_other'), 'url keeps the selected site');
  } finally {
    await app.close();
  }
});

test('long identifiers keep their full value for tooltips instead of breaking layout', async () => {
  const app = await launch({ token: 'cflab', routes: baseRoutes });
  try {
    await waitFor(() => app.document.querySelector('#overview-pages .bar-label'), 'page bars');
    const label = app.document.querySelector('#overview-pages .bar-label');
    assert.equal(label.textContent, LONG_PATH);
    assert.equal(label.getAttribute('title'), LONG_PATH);
    assert.equal(label.classList.contains('bar-label'), true);
    const referrer = app.document.querySelector('#overview-referrers .bar-label');
    assert.equal(referrer.getAttribute('title'), 'direct');
  } finally {
    await app.close();
  }
});
