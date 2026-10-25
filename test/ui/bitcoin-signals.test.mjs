import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { SIGNALS_SCRIPT, signalsPage } from '../../src/bitcoin-signals/dashboard.js';

const NOW = '2026-10-25T16:00:00.000Z';
const SOURCE_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';

function radarPayload() {
  return {
    generated_at: NOW,
    caller: { email: 'admin@example.com', is_admin: true, access: 'write' },
    indicators: [
      {
        series: 'spot_price_usd', venue: 'coinbase', label: 'BTC spot price', unit: 'USD per BTC', tier: 'measured',
        value: 80560.61, observed_at: NOW, retrieved_at: NOW, age_hours: 0.1, stale: false, stale_after_hours: 3,
        change_7d_pct: 1.25, source_id: 'coinbase-spot', source_url: SOURCE_URL,
        definition: 'Last traded price of one bitcoin in USD.',
        points: [{ at: '2026-10-25T14:00:00.000Z', value: 80000 }, { at: '2026-10-25T15:00:00.000Z', value: 80560.61 }],
        meta: {},
      },
      {
        series: 'funding_current_8h', venue: 'okx', label: 'Funding rate', unit: 'fraction per 8h', tier: 'measured',
        value: 0.00006, observed_at: NOW, retrieved_at: NOW, age_hours: 4.2, stale: true, stale_after_hours: 3,
        change_7d_pct: null, source_id: 'okx', source_url: 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP',
        definition: 'Current funding rate normalized to 8h.', meta: { interval_hours: 8 },
      },
    ],
    treasuries: [{ venue: 'MSTR.US', btc: 848517, name: 'Strategy', country: 'US', observed_at: NOW, stale: false }],
    hypotheses: [
      { id: 'treasury-demand', title: 'Bitcoin treasury demand is increasing', question: 'Are balance sheets accumulating?', evidence: { total: 2, supports: 1, contradicts: 1, mixed: 0, verified: 1, last_at: NOW } },
    ],
    curated: [{ kind: 'retention', entries: 3, last_at: NOW }],
    alerts: [{ id: 'a1', severity: 'warning', title: 'Sustained funding on okx', detail: 'Mean funding 6.00 bps', created_at: NOW }],
    collection: {
      last_runs: [{ job: 'hourly', status: 'ok', started_at: NOW, finished_at: NOW, observations_added: 12, sources_ok: 6, sources_failed: 0, detail: null }],
      sources: [], failing_sources: 0, stale_sources: 0,
    },
  };
}

function arbitragePayload() {
  return {
    generated_at: NOW,
    assumptions: { feeBpsPerLeg: 2, slippageBpsPerLeg: 1, legs: 4, holdingDays: 30 },
    assumption_note: null,
    venues: [{
      venue: 'okx', funding_8h: 0.00006, funding_8h_pct: 0.006, interval_hours: 8, observed_at: NOW, age_hours: 0.2, stale: false,
      mark_price_usd: null, index_price_usd: 80490.25,
      carry: { gross_apr_pct: 6.57, gross_apy_pct: 6.79, holding_return_pct: 0.54, cost_pct: 0.12, cost_apr_pct: 1.46, net_apr_pct: 5.11, net_holding_pct: 0.42, breakeven_periods: 20, profitable: true },
      persistence: { basis: 'settled', samples: 6, coverage_hours: 40, mean_8h_pct: 0.006, median_8h_pct: 0.006, positive_share: 0.83, negative_share: 0.17, longest_positive_run: 5, longest_negative_run: 1, cumulative_pct: 0.036 },
      limitations: ['Access depends on jurisdiction.'],
    }],
    basis: [{ venue: 'deribit', instrument: 'BTC-27NOV26', expiry: '2026-11-24T12:00:00.000Z', days_to_expiry: 30, mark_usd: 81600, index_usd: 80000, basis_pct: 2, annualized_pct: 24.33, cost_apr_pct: 1.46, net_annualized_pct: 22.87, observed_at: NOW, stale: false }],
    best_funding: { venue: 'okx', net_apr_pct: 5.11 },
    best_basis: { venue: 'deribit', instrument: 'BTC-27NOV26', net_annualized_pct: 22.87 },
    disclaimer: 'Indicative research only. It is not guaranteed income.',
  };
}

function evidencePayload() {
  return {
    total: 1,
    items: [{
      id: '5f0f0f0f-0000-4000-8000-000000000001', kind: 'settlement', title: 'Two states document a settlement pilot',
      summary: 'A joint statement describes a cross-border pilot.', occurred_at: '2026-10-01T00:00:00.000Z', jurisdiction: 'US',
      status: 'pilot', direction: 'supports', importance: 'high', source_title: 'Joint statement',
      source_url: 'https://example.gov/joint-statement', published_at: null, retrieved_at: NOW,
      review_status: 'unreviewed', reviewed_at: null, created_at: NOW,
      hypotheses: [{ id: 'sovereign-downstream', effect: 'supports' }],
    }],
    filters: {},
  };
}

function settingsPayload() {
  return {
    generated_at: NOW,
    project: { app_id: 'bitcoin-signals', name: 'Bitcoin Signals', dashboard: '/bitcoin-signals', storage: { backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', label: 'cflab-bitcoin-signals', migrations_dir: 'migrations-bitcoin-signals', registered: true, reachable: true } },
    data: { observations: 120, evidence: 3, alerts_open: 1, last_observation_at: NOW, oldest_observation_at: NOW },
    collection: {
      last_runs: [{ job: 'hourly', status: 'ok', started_at: NOW, finished_at: NOW, observations_added: 12, sources_ok: 6, sources_failed: 0, detail: null }],
      sources: [{ source_id: 'okx', name: 'OKX public market data', cadence: 'hourly', tier: 'measured', last_ok_at: NOW, age_hours: 0.2, last_error_code: null, last_error_at: null, healthy: true }],
      failing_sources: 0, stale_sources: 0,
    },
    alerts: [],
    backup: { recorded: true, checked_at: NOW, age_hours: 4, ok: true, max_age_hours: 30, source: 'scripts/backup/backup-status.mjs', note: 'All three databases had a verified backup.' },
    backups_expected: { databases: ['cflab', 'cflab-analytics', 'cflab-bitcoin-signals'], max_age_hours: 30, command: 'node scripts/backup/backup-status.mjs --json' },
    settings: { notifications: { enabled: false, email_to: '' }, rules: { funding_threshold_bps_8h: 5, funding_sustained_periods: 6, funding_window_hours: 48, treasury_change_pct: 2, treasury_change_btc: 1000, stale_multiplier: 3, error_streak: 3 } },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function waitFor(check, label, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function launch({ token = 'cflab-session', routes = {}, url = 'http://localhost:8799/bitcoin-signals' } = {}) {
  const window = new Window({ url });
  const html = signalsPage().replace(/<script>[\s\S]*<\/script>/, '');
  window.document.write(html);
  const calls = [];
  const bodies = [];
  window.sessionStorage.setItem('cflab_session', token);
  window.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(requestUrl, url).pathname + new URL(requestUrl, url).search;
    calls.push(`${method} ${path}`);
    if (init.body) bodies.push({ path, body: JSON.parse(init.body) });
    const handler = routes[`${method} ${path.split('?')[0]}`] ?? routes[`${method} ${path}`];
    if (handler) return handler(path);
    return jsonResponse({ error: { code: 'not_found', message: `no stub for ${method} ${path}` } }, 404);
  };
  window.eval(SIGNALS_SCRIPT);
  const document = window.document;
  return { window, document, calls, bodies, close: () => window.close() };
}

test('the page carries four sections, a mobile viewport, and no external runtime assets', () => {
  const html = signalsPage();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  for (const id of ['panel-radar', 'panel-arbitrage', 'panel-evidence', 'panel-settings']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.includes('Bitcoin Signals'));
  assert.match(html, /@media \(max-width:900px\)/);
  assert.match(html, /@media \(max-width:640px\)/);
  assert.match(html, /\.table td::before\{content:attr\(data-label\)/);
  // No CDN, no external script, no third-party image or stylesheet.
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external script');
  assert.ok(!/<link[^>]+href="https?:/i.test(html), 'no external stylesheet');
  assert.ok(!/<img[^>]+src="https?:/i.test(html), 'no external image');
  assert.ok(!/on(click|load|submit)=/i.test(html), 'no inline event handlers in markup');
});

test('renders current indicators with value, freshness, and source evidence', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/arbitrage': () => jsonResponse(arbitragePayload()),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    const cards = app.document.querySelectorAll('#radar-grid .card');
    assert.ok(cards[0].textContent.includes('BTC spot price'), 'label rendered');
    assert.ok(cards[0].textContent.includes('80,560.61'), 'value rendered');
    assert.ok(cards[0].textContent.includes('+1.25% vs ~7d'), 'weekly change rendered');
    const source = cards[0].querySelector('a');
    assert.equal(source.getAttribute('href'), SOURCE_URL);
    assert.equal(source.getAttribute('rel'), 'noreferrer noopener');
    assert.ok(cards[0].querySelector('svg.spark polyline'), 'history sparkline drawn');
    // A stale quote is labelled, not hidden and not silently averaged in.
    assert.ok(cards[1].textContent.includes('stale'), 'stale badge rendered');
    assert.ok(cards[1].textContent.includes('Source interval 8h'), 'funding interval disclosed');
    assert.ok(app.document.getElementById('radar-flags').textContent.includes('hourly ok'));
    assert.ok(app.document.getElementById('hypotheses').textContent.includes('Bitcoin treasury demand is increasing'));
    assert.ok(app.document.getElementById('radar-alerts').textContent.includes('Sustained funding on okx'));
    assert.ok(app.document.getElementById('curated').textContent.includes('retention'));
  } finally {
    await app.close();
  }
});

test('switches sections and keeps mobile-friendly table labels', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/arbitrage': () => jsonResponse(arbitragePayload()),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    assert.equal(app.document.getElementById('panel-arbitrage').hidden, true);
    app.document.querySelector('.tab[data-tab=arbitrage]').click();
    await waitFor(() => app.document.getElementById('arb-venues').querySelector('table'), 'arbitrage table');
    assert.equal(app.document.getElementById('panel-arbitrage').hidden, false);
    assert.equal(app.document.getElementById('panel-radar').hidden, true);
    assert.equal(app.document.querySelector('.tab[data-tab=arbitrage]').getAttribute('aria-selected'), 'true');
    assert.ok(app.window.location.hash.includes('arbitrage'), 'section kept in the hash');
    const venueRow = app.document.querySelector('#arb-venues tbody tr');
    assert.ok(venueRow.textContent.includes('okx'));
    assert.ok(venueRow.textContent.includes('5.11%'), 'net carry rendered');
    assert.ok(venueRow.textContent.includes('6.57%'), 'gross APR rendered');
    for (const cell of venueRow.querySelectorAll('td')) {
      assert.ok(cell.getAttribute('data-label'), 'every mobile cell has a label');
    }
    assert.ok(app.document.getElementById('arb-basis').textContent.includes('BTC-27NOV26'));
    assert.ok(app.document.getElementById('arb-basis').textContent.includes('22.87%'));
    assert.ok(app.document.getElementById('arb-persistence').textContent.includes('settled'));
    assert.match(app.document.getElementById('arb-disclaimer').textContent, /not guaranteed income/i);
    assert.ok(app.calls.includes('GET /api/bitcoin-signals/arbitrage'));
  } finally {
    await app.close();
  }
});

test('recalculates carry with operator assumptions instead of a fixed number', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/arbitrage': () => jsonResponse(arbitragePayload()),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    app.document.querySelector('.tab[data-tab=arbitrage]').click();
    await waitFor(() => app.document.getElementById('fee-bps').value === '2', 'assumptions prefilled');
    app.document.getElementById('fee-bps').value = '10';
    app.document.getElementById('holding-days').value = '7';
    app.document.getElementById('assumptions-form').dispatchEvent(new app.window.Event('submit'));
    await waitFor(() => app.calls.some(call => call.includes('fee_bps=10') && call.includes('holding_days=7')), 'assumption query');
  } finally {
    await app.close();
  }
});

test('records a human review from the evidence timeline', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/evidence': () => jsonResponse(evidencePayload()),
      'PATCH /api/bitcoin-signals/evidence/5f0f0f0f-0000-4000-8000-000000000001': () => jsonResponse({ updated: true }),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    app.document.querySelector('.tab[data-tab=evidence]').click();
    await waitFor(() => app.document.querySelector('#evidence-list .evidence-item'), 'evidence item');
    const item = app.document.querySelector('#evidence-list .evidence-item');
    assert.ok(item.textContent.includes('Two states document a settlement pilot'));
    assert.ok(item.textContent.includes('stage: pilot'));
    assert.ok(item.textContent.includes('unreviewed'));
    assert.ok(item.textContent.includes('sovereign-downstream'));
    const source = item.querySelector('a');
    assert.equal(source.getAttribute('href'), 'https://example.gov/joint-statement');
    const verify = [...item.querySelectorAll('button[data-review]')].find(button => button.getAttribute('data-review') === 'verified');
    assert.ok(verify, 'verify button is available to a writer');
    verify.click();
    await waitFor(() => app.bodies.some(entry => entry.path.includes('/evidence/') && entry.body.review_status === 'verified'), 'review request');
    await waitFor(() => app.document.getElementById('msg').textContent.includes('Review recorded'), 'review confirmation');
    // A read-only member never sees the review or create controls.
    const reader = await launch({
      routes: {
        'GET /api/bitcoin-signals/radar': () => jsonResponse({ ...radarPayload(), caller: { email: 'reader@example.com', is_admin: false, access: 'read' } }),
        'GET /api/bitcoin-signals/evidence': () => jsonResponse(evidencePayload()),
      },
    });
    try {
      await waitFor(() => reader.document.querySelectorAll('#radar-grid .card').length === 2, 'reader radar');
      assert.equal(reader.document.getElementById('evidence-create-panel').hidden, true);
      reader.document.querySelector('.tab[data-tab=evidence]').click();
      await waitFor(() => reader.document.querySelector('#evidence-list .evidence-item'), 'reader evidence');
      assert.equal(reader.document.querySelectorAll('#evidence-list button[data-review]').length, 0);
    } finally {
      await reader.close();
    }
  } finally {
    await app.close();
  }
});

test('shows storage, collection health, alerts, and backup status in settings', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/settings': () => jsonResponse({ ...settingsPayload(), status: settingsPayload() }),
      'PATCH /api/bitcoin-signals/settings': () => jsonResponse({ notifications: { enabled: true, email_to: 'research@example.com' }, rules: settingsPayload().settings.rules, assumptions: {} }),
      'GET /api/bitcoin-signals/status': () => jsonResponse(settingsPayload()),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    app.document.querySelector('.tab[data-tab=settings]').click();
    await waitFor(() => app.document.getElementById('settings-storage').textContent.includes('BTC_SIGNALS'), 'storage panel');
    assert.ok(app.document.getElementById('settings-storage').textContent.includes('migrations-bitcoin-signals'));
    assert.ok(app.document.getElementById('settings-storage').textContent.includes('120'), 'observation count');
    assert.ok(app.document.getElementById('settings-collection').textContent.includes('okx'));
    assert.ok(app.document.getElementById('settings-collection').textContent.includes('fresh'));
    assert.ok(app.document.getElementById('settings-backup').textContent.includes('verified fresh'));
    assert.ok(app.document.getElementById('settings-backup').textContent.includes('cflab-bitcoin-signals'));
    // Notifications are off until the operator enables them, then saved explicitly.
    assert.equal(app.document.getElementById('alerts-enabled').value, 'false');
    app.document.getElementById('alerts-enabled').value = 'true';
    app.document.getElementById('alerts-email').value = 'research@example.com';
    app.document.getElementById('alerts-form').dispatchEvent(new app.window.Event('submit'));
    await waitFor(() => app.bodies.some(entry => entry.path.includes('/settings') && entry.body.notifications?.enabled === true), 'settings save');
    const saved = app.bodies.find(entry => entry.path.includes('/settings') && entry.body.notifications);
    assert.equal(saved.body.notifications.email_to, 'research@example.com');
    assert.equal(saved.body.rules.funding_threshold_bps_8h, 5);
    assert.equal(typeof saved.body.rules.treasury_change_btc, 'number');
  } finally {
    await app.close();
  }
});

test('an administrator can refresh collection and record a backup attestation', async () => {
  const app = await launch({
    routes: {
      'GET /api/bitcoin-signals/radar': () => jsonResponse(radarPayload()),
      'GET /api/bitcoin-signals/settings': () => jsonResponse({ ...settingsPayload(), status: settingsPayload() }),
      'POST /api/bitcoin-signals/refresh': () => jsonResponse({ runs: [{ job: 'hourly', status: 'ok', reason: undefined, observations_added: 3, sources: [1, 2, 3, 4, 5, 6] }] }),
      'POST /api/bitcoin-signals/backup-attestation': () => jsonResponse({ recorded: true, checked_at: NOW, ok: true }),
    },
  });
  try {
    await waitFor(() => app.document.querySelectorAll('#radar-grid .card').length === 2, 'radar cards');
    app.document.querySelector('.tab[data-tab=settings]').click();
    await waitFor(() => app.document.getElementById('refresh-hourly'), 'admin controls');
    app.document.getElementById('refresh-hourly').click();
    await waitFor(() => app.document.getElementById('refresh-msg').textContent.includes('hourly: ok'), 'refresh message');
    const report = { ok: true, max_age_hours: 30, report: [
      { database: 'cflab', status: 'fresh' }, { database: 'cflab-analytics', status: 'fresh' }, { database: 'cflab-bitcoin-signals', status: 'fresh' },
    ] };
    app.document.getElementById('backup-report').value = JSON.stringify(report);
    app.document.getElementById('backup-form').dispatchEvent(new app.window.Event('submit'));
    await waitFor(() => app.bodies.some(entry => entry.path.includes('backup-attestation')), 'attestation request');
    const attestation = app.bodies.find(entry => entry.path.includes('backup-attestation'));
    assert.equal(attestation.body.report.length, 3);
    await waitFor(() => app.document.getElementById('backup-msg').textContent.includes('all three databases fresh'), 'attestation confirmation');
  } finally {
    await app.close();
  }
});
