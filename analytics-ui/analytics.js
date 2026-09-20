import {
  RANGES, TABS, rangeFor, previousRange, metricCards, reportPath, seriesForMetric,
  domainChoices, validTab, formatNumber, formatDateTime, stateFromSearch, searchFromState,
  formatBucketLabel, share,
} from './lib.js';
import {
  $, clear, show, setText, h, skeleton, endSkeleton, errorBlock, emptyBlock,
  renderKpis, barsBlock, dataTable, shareCell, recentTable, flash,
} from './ui.js';
import { renderTimeseries, renderDeviceBreakdown, destroyAll, chartsAvailable } from './charts.js';

const TOKEN_KEY = 'cflab.analytics.token';
const LIVE_INTERVAL_MS = 15_000;
const CHART_METRICS = [
  { key: 'pageviews', label: 'Pageviews' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'events', label: 'Events' },
];

const state = {
  token: null,
  email: '',
  isAdmin: false,
  sites: [],
  site: null,
  role: null,
  domains: [],
  lastEventAt: null,
  range: '30d',
  from: '',
  to: '',
  domain: '',
  tab: 'overview',
  metric: 'pageviews',
  rangeInfo: null,
  data: {},
  loaded: {},
  epoch: 0,
  liveTimer: null,
  settingsLoaded: false,
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function authBase() {
  const meta = document.querySelector('meta[name="cflab-auth-base"]');
  return (meta && meta.getAttribute('content')) || 'https://cflab.aismallbizguru.com';
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again.';
    if (error.status === 403) return 'You do not have access to this site.';
    if (error.status === 429) return 'Too many requests. Wait a moment and retry.';
    if (error.status === 503) return 'The authentication service is unavailable. Try again.';
    if (error.status === 0) return 'Unable to reach the analytics service. Check your connection.';
    return error.message || 'Unable to load analytics.';
  }
  return 'Unable to load analytics.';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Unable to reach the analytics service.');
  }
  if (response.status === 401) {
    signOutLocal();
    showLogin('Your session has expired. Sign in again.');
    throw new ApiError(401, 'unauthorized', 'Your session has expired.');
  }
  let data = null;
  if (response.status !== 204) {
    try { data = await response.json(); } catch { data = null; }
  }
  if (!response.ok) {
    const code = (data && data.error && data.error.code) || 'error';
    const message = (data && data.error && data.error.message) || 'Unable to load analytics.';
    throw new ApiError(response.status, code, message);
  }
  return data;
}

/* Authentication */

function showLogin(message) {
  state.token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  stopLive();
  show($('#app-view'), false);
  show($('#login-view'), true);
  setText($('#login-error'), message || '');
  const email = $('#login-email');
  if (email) email.focus();
}

function showApp() {
  show($('#login-view'), false);
  show($('#app-view'), true);
}

function signOutLocal() {
  state.token = null;
  state.site = null;
  state.sites = [];
  state.domains = [];
  sessionStorage.removeItem(TOKEN_KEY);
  stopLive();
}

async function signIn(email, password) {
  let response;
  try {
    response = await fetch(`${authBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error('Could not reach CFLab. Check your connection.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error('Invalid email or password.');
    if (response.status === 403) throw new Error('This browser origin is not allowed.');
    if (response.status === 429) throw new Error('Too many sign-in attempts. Wait a minute and try again.');
    throw new Error((data && data.error && data.error.message) || 'Unable to sign in.');
  }
  state.token = data.token;
  sessionStorage.setItem(TOKEN_KEY, data.token);
}

async function loadIdentity() {
  try {
    const response = await fetch(`${authBase()}/api/auth/me`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) return;
    const data = await response.json();
    state.email = (data && data.user && data.user.email) || '';
    state.isAdmin = !!(data && data.user && data.user.is_admin);
    setText($('#account-email'), state.email);
    show($('#new-site'), state.isAdmin);
  } catch {
    /* identity display is optional */
  }
}

/* URL and state */

function updateUrl() {
  if (!state.site) return;
  const query = searchFromState({
    site: state.site ? state.site.public_id : '',
    domain: state.domain,
    range: state.range,
    from: state.from,
    to: state.to,
    tab: state.tab,
  });
  try {
    history.replaceState(null, '', query || location.pathname);
  } catch {
    /* ignore history failures */
  }
}

function currentRange() {
  state.rangeInfo = rangeFor(state.range, new Date(), state.from, state.to);
  return state.rangeInfo;
}

function reportParams(extra = {}) {
  const range = currentRange();
  return { from: range.from, to: range.to, domain: state.domain, ...extra };
}

/* Header and tabs */

function renderSiteOptions() {
  const select = $('#site-select');
  clear(select);
  for (const site of state.sites) {
    select.append(h('option', { value: site.public_id, text: site.name }));
  }
  select.value = state.site ? state.site.public_id : '';
}

function renderDomainOptions() {
  const select = $('#domain-select');
  clear(select);
  select.append(h('option', { value: '', text: 'All domains' }));
  for (const choice of domainChoices(state.domains)) {
    select.append(h('option', { value: choice.hostname, text: choice.label }));
  }
  select.value = state.domain || '';
}

function renderRangeOptions() {
  const select = $('#range-select');
  clear(select);
  for (const range of RANGES) select.append(h('option', { value: range.value, text: range.label }));
  select.value = state.range;
  show($('#custom-range'), state.range === 'custom');
  if (state.range === 'custom') {
    $('#range-from').value = state.from || '';
    $('#range-to').value = state.to || '';
  }
}

function renderMetricSwitch() {
  const group = $('#metric-switch');
  clear(group);
  for (const metric of CHART_METRICS) {
    group.append(h('button', {
      type: 'button',
      class: 'segment',
      text: metric.label,
      'aria-pressed': String(state.metric === metric.key),
      onclick: () => {
        state.metric = metric.key;
        renderMetricSwitch();
        renderChart();
      },
    }));
  }
}

function renderTabs() {
  const nav = $('#tabs');
  clear(nav);
  for (const tab of TABS) {
    nav.append(h('button', {
      type: 'button',
      class: 'tab',
      id: `tab-${tab.id}`,
      role: 'tab',
      'aria-selected': String(state.tab === tab.id),
      'aria-controls': `panel-${tab.id}`,
      text: tab.label,
      onclick: () => setTab(tab.id),
    }));
  }
  nav.onkeydown = event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = TABS.findIndex(tab => tab.id === state.tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length;
    event.preventDefault();
    setTab(TABS[next].id);
    const button = $(`#tab-${TABS[next].id}`);
    if (button) button.focus();
  };
}

function setTab(tab, options = {}) {
  state.tab = validTab(tab);
  for (const item of TABS) {
    const button = $(`#tab-${item.id}`);
    const panel = $(`#panel-${item.id}`);
    const active = item.id === state.tab;
    if (button) button.setAttribute('aria-selected', String(active));
    show(panel, active);
  }
  updateUrl();
  stopLive();
  if (state.tab === 'overview') {
    startLive();
    if (state.data.timeseries) renderChart();
  }
  loadActiveTab(options);
}

function renderRoleNote() {
  const note = $('#settings-role-note');
  if (!note) return;
  const role = state.role || 'viewer';
  if (role === 'owner') {
    show(note, false);
    return;
  }
  note.textContent = role === 'editor'
    ? 'You have editor access: reports and the tracking snippet are available; Site settings are read-only.'
    : 'You have viewer access: reports are available; Site settings are read-only.';
  show(note, true);
}

/* Site loading */

function setBusy(busy) {
  for (const id of ['#site-select', '#domain-select', '#range-select', '#refresh']) {
    const control = $(id);
    if (control) control.disabled = busy;
  }
}

function renderFatal(error) {
  const container = $('#overview-content');
  if (!container) return;
  show($('#overview-empty'), false);
  show(container, true);
  clear($('#kpi-grid'));
  clear($('#overview-pages'));
  clear($('#overview-referrers'));
  clear($('#overview-devices'));
  clear($('#overview-platforms'));
  clear($('#overview-recent'));
  clear($('#overview-live'));
  $('#kpi-grid').append(errorBlock(friendlyError(error), () => loadActiveTab({ force: true })));
}

async function selectSite(ref, options = {}) {
  const epoch = ++state.epoch;
  setBusy(true);
  try {
    const detail = await api(`/api/sites/${encodeURIComponent(ref)}`);
    if (epoch !== state.epoch) return;
    state.site = detail.site;
    state.role = detail.site.role || 'viewer';
    state.domains = detail.domains || [];
    state.lastEventAt = detail.last_event_at_ms ?? null;
    state.loaded = {};
    state.data = {};
    state.settingsLoaded = false;
    const choices = domainChoices(state.domains);
    if (state.domain && !choices.some(choice => choice.hostname === state.domain)) state.domain = '';
    renderSiteOptions();
    renderDomainOptions();
    renderRoleNote();
    updateUrl();
    await loadActiveTab({ force: true });
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error.status !== 401) renderFatal(error);
  } finally {
    if (epoch === state.epoch) setBusy(false);
  }
}

function renderNoSites() {
  show($('#overview-content'), false);
  const container = $('#overview-empty');
  show(container, true);
  clear(container);
  container.append(emptyBlock(
    'No sites yet',
    state.isAdmin ? 'Create your first analytics Site to start collecting data.' : 'Ask a CFLab administrator to give you access to a Site.',
    state.isAdmin ? 'Add site' : null,
    state.isAdmin ? () => openNewSiteDialog() : null,
  ));
}

async function loadSitesAndStart() {
  try {
    const data = await api('/api/sites');
    state.sites = data.sites || [];
  } catch (error) {
    if (error.status === 401) return;
    showLogin('Unable to load your sites. Try again.');
    return;
  }
  renderSiteOptions();
  if (!state.sites.length) {
    renderNoSites();
    loadIdentity();
    return;
  }
  const initial = stateFromSearch(location.search);
  const chosen = state.sites.find(site => site.public_id === initial.site) || state.sites[0];
  await selectSite(chosen.public_id);
  loadIdentity();
}
/* Tab loading */

async function loadActiveTab(options = {}) {
  if (!state.site) return;
  if (state.loaded[state.tab] && !options.force) return;
  state.loaded[state.tab] = true;
  if (state.tab === 'overview') return loadOverview();
  if (state.tab === 'pages') return loadPages();
  if (state.tab === 'acquisition') return loadAcquisition();
  if (state.tab === 'events') return loadEvents();
  if (state.tab === 'settings') return loadSettings();
}

function retryCurrent() {
  state.loaded[state.tab] = false;
  loadActiveTab({ force: true });
}

/* Overview */

function renderOverviewEmpty() {
  show($('#overview-content'), false);
  setText($('#live-stats'), '');
  const container = $('#overview-empty');
  show(container, true);
  clear(container);
  container.append(emptyBlock(
    'No analytics yet',
    'Install the tracking snippet on your site and visit a page to start collecting data.',
    'View setup',
    () => setTab('settings'),
  ));
}

async function loadOverview() {
  const epoch = state.epoch;
  const range = currentRange();
  const previous = previousRange(range);
  const siteRef = state.site.public_id;

  show($('#overview-empty'), false);
  show($('#overview-content'), true);
  skeleton($('#kpi-grid'), 4, 'kpi');
  skeleton($('#timeseries-table'), 4);
  for (const id of ['#overview-pages', '#overview-referrers', '#overview-devices', '#overview-platforms', '#overview-recent', '#overview-live']) {
    skeleton($(id), 4);
  }

  const results = await Promise.allSettled([
    api(reportPath(siteRef, 'summary', reportParams())),
    api(reportPath(siteRef, 'summary', { domain: state.domain, from: previous.from, to: previous.to })),
    api(reportPath(siteRef, 'timeseries', reportParams({ bucket: range.bucket }))),
    api(reportPath(siteRef, 'pages', reportParams({ limit: 6 }))),
    api(reportPath(siteRef, 'referrers', reportParams({ limit: 6 }))),
    api(reportPath(siteRef, 'devices', reportParams({ limit: 6 }))),
    api(reportPath(siteRef, 'recent', reportParams({ limit: 8 }))),
  ]);
  if (epoch !== state.epoch) return;

  const [summaryResult, previousResult, timeseriesResult, pagesResult, referrersResult, devicesResult, recentResult] = results;
  const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
  const previousSummary = previousResult.status === 'fulfilled' ? previousResult.value : null;

  if (summary && previousSummary && summary.pageviews === 0 && summary.events === 0 && !state.lastEventAt) {
    endSkeleton($('#kpi-grid'));
    renderOverviewEmpty();
    return;
  }

  endSkeleton($('#kpi-grid'));
  if (summary) {
    renderKpis($('#kpi-grid'), metricCards(summary, previousSummary));
  } else {
    clear($('#kpi-grid'));
    $('#kpi-grid').append(errorBlock(friendlyError(summaryResult.reason), retryCurrent));
  }

  if (timeseriesResult.status === 'fulfilled') {
    state.data.timeseries = timeseriesResult.value;
    renderChart();
  } else {
    state.data.timeseries = null;
    const holder = $('#timeseries-chart') && $('#timeseries-chart').parentElement;
    if (holder) { clear(holder); holder.append(errorBlock(friendlyError(timeseriesResult.reason), retryCurrent)); }
  }

  renderOverviewPages(pagesResult);
  renderOverviewReferrers(referrersResult);
  renderOverviewDevices(devicesResult);
  renderOverviewPlatforms(devicesResult);
  renderOverviewRecent(recentResult);
  refreshLive();
}

function renderChart() {
  const data = state.data.timeseries;
  if (!data) return;
  const metric = CHART_METRICS.find(item => item.key === state.metric) || CHART_METRICS[0];
  const series = seriesForMetric(data.points, metric.key);
  const canvas = $('#timeseries-chart');
  const holder = canvas && canvas.parentElement;
  if (holder && !holder.querySelector('canvas')) {
    clear(holder);
    holder.append(h('canvas', { id: 'timeseries-chart', 'aria-label': `${metric.label} over time` }));
  }
  const rendered = renderTimeseries($('#timeseries-chart'), series, { metricLabel: metric.label });
  if (!rendered && holder) {
    clear(holder);
    holder.append(emptyBlock('Chart unavailable', 'The chart library did not load. The data table below still has the values.'));
  }
  const rows = (data.points || []).map(point => ({
    date: formatBucketLabel(data.bucket, point.date),
    value: point[metric.key],
  }));
  const table = $('#timeseries-table');
  if (table) {
    clear(table);
    table.append(dataTable(
      [{ key: 'date', label: 'Date' }, { key: 'value', label: metric.label, className: 'num' }],
      rows,
    ));
  }
}

function renderOverviewPages(result) {
  const container = $('#overview-pages');
  if (!container) return;
  clear(container);
  if (result.status !== 'fulfilled') {
    container.append(errorBlock(friendlyError(result.reason), retryCurrent));
    return;
  }
  container.append(barsBlock(result.value.pages, {
    label: page => page.pathname,
    value: page => page.pageviews,
    secondary: page => `${formatNumber(page.sessions)} sessions`,
    title: page => page.pathname,
  }));
}

function renderOverviewReferrers(result) {
  const container = $('#overview-referrers');
  if (!container) return;
  clear(container);
  if (result.status !== 'fulfilled') {
    container.append(errorBlock(friendlyError(result.reason), retryCurrent));
    return;
  }
  container.append(barsBlock(result.value.referrers, {
    label: row => row.referrer,
    value: row => row.pageviews,
    secondary: row => `${formatNumber(row.sessions)} sessions`,
    title: row => row.referrer,
  }));
}

function renderOverviewDevices(result) {
  const container = $('#overview-devices');
  if (!container) return;
  const canvas = $('#device-chart');
  const holder = canvas && canvas.parentElement;
  clear(container);
  if (result.status !== 'fulfilled') {
    if (holder) show(holder, false);
    container.append(errorBlock(friendlyError(result.reason), retryCurrent));
    return;
  }
  const devices = result.value.devices || [];
  if (!devices.length) {
    if (holder) show(holder, false);
    container.append(emptyBlock('No data', 'No device data in this period.'));
    return;
  }
  if (holder) {
    show(holder, true);
    if (!holder.querySelector('canvas')) {
      clear(holder);
      holder.append(h('canvas', { id: 'device-chart', 'aria-label': 'Device categories' }));
    }
    renderDeviceBreakdown($('#device-chart'), devices);
  }
  const total = devices.reduce((sum, item) => sum + (Number(item.pageviews) || 0), 0);
  container.append(barsBlock(devices, {
    label: item => item.value,
    value: item => item.pageviews,
    secondary: item => `${Math.round(share(item.pageviews, total) * 10) / 10}%`,
  }));
}

function renderOverviewPlatforms(result) {
  const container = $('#overview-platforms');
  if (!container) return;
  clear(container);
  if (result.status !== 'fulfilled') {
    container.append(errorBlock(friendlyError(result.reason), retryCurrent));
    return;
  }
  const data = result.value;
  const section = (title, items) => h('div', { class: 'bars-section' }, [
    h('p', { class: 'bars-heading', text: title }),
    barsBlock((items || []).slice(0, 5), { label: item => item.value, value: item => item.pageviews }),
  ]);
  container.append(section('Browsers', data.browsers));
  container.append(section('Operating systems', data.operating_systems));
}

function renderOverviewRecent(result) {
  const container = $('#overview-recent');
  if (!container) return;
  clear(container);
  if (result.status !== 'fulfilled') {
    container.append(errorBlock(friendlyError(result.reason), retryCurrent));
    return;
  }
  container.append(recentTable(result.value.events));
}

function renderLive(data) {
  setText($('#live-stats'), `${formatNumber(data.sessions)} active sessions · last 5 minutes`);
  const container = $('#overview-live');
  if (!container) return;
  clear(container);
  if (!data.events) {
    container.append(emptyBlock('Quiet right now', 'No activity in the last 5 minutes.'));
    return;
  }
  container.append(barsBlock(data.pages, {
    label: page => page.pathname,
    value: page => page.events,
    title: page => page.pathname,
    emptyMessage: 'No live activity in the last 5 minutes.',
  }));
}

async function refreshLive() {
  if (!state.site || state.tab !== 'overview' || document.visibilityState === 'hidden') return;
  try {
    const data = await api(reportPath(state.site.public_id, 'live', { domain: state.domain }));
    if (state.tab !== 'overview') return;
    renderLive(data);
  } catch {
    /* live is best-effort; keep the previous snapshot */
  }
}

function startLive() {
  stopLive();
  if (!state.site || state.tab !== 'overview' || document.visibilityState === 'hidden') return;
  state.liveTimer = setInterval(refreshLive, LIVE_INTERVAL_MS);
}

function stopLive() {
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
}

/* Pages */

async function loadPages() {
  const epoch = state.epoch;
  const container = $('#pages-table');
  if (!container) return;
  skeleton(container, 6);
  try {
    const data = await api(reportPath(state.site.public_id, 'pages', reportParams({ limit: 50 })));
    if (epoch !== state.epoch) return;
    endSkeleton(container);
    setText($('#pages-note'), `${formatNumber(data.pages.reduce((sum, page) => sum + (Number(page.pageviews) || 0), 0))} pageviews`);
    const total = data.pages.reduce((sum, page) => sum + (Number(page.pageviews) || 0), 0);
    const columns = [
      { key: 'pathname', label: 'Page', className: 'col-path', title: page => page.pathname },
      { key: 'pageviews', label: 'Pageviews', className: 'num col-num' },
      { key: 'sessions', label: 'Sessions', className: 'num col-num' },
      { key: 'share', label: '% of total', className: 'col-share', render: page => shareCell(page.pageviews, total) },
    ];
    clear(container);
    container.append(dataTable(columns, data.pages));
  } catch (error) {
    if (epoch !== state.epoch) return;
    endSkeleton(container);
    clear(container);
    container.append(errorBlock(friendlyError(error), retryCurrent));
  }
}

/* Acquisition */

async function loadAcquisition() {
  const epoch = state.epoch;
  const referrers = $('#acquisition-referrers');
  const campaigns = $('#acquisition-campaigns');
  if (!referrers || !campaigns) return;
  skeleton(referrers, 5);
  skeleton(campaigns, 5);
  const [referrersResult, campaignsResult] = await Promise.allSettled([
    api(reportPath(state.site.public_id, 'referrers', reportParams({ limit: 20 }))),
    api(reportPath(state.site.public_id, 'campaigns', reportParams({ limit: 20 }))),
  ]);
  if (epoch !== state.epoch) return;
  endSkeleton(referrers);
  endSkeleton(campaigns);
  clear(referrers);
  if (referrersResult.status === 'fulfilled') {
    referrers.append(barsBlock(referrersResult.value.referrers, {
      label: row => row.referrer,
      value: row => row.pageviews,
      secondary: row => `${formatNumber(row.sessions)} sessions`,
      title: row => row.referrer,
      emptyMessage: 'No referrers in this period.',
    }));
  } else {
    referrers.append(errorBlock(friendlyError(referrersResult.reason), retryCurrent));
  }
  clear(campaigns);
  if (campaignsResult.status !== 'fulfilled') {
    campaigns.append(errorBlock(friendlyError(campaignsResult.reason), retryCurrent));
    return;
  }
  const rows = campaignsResult.value.campaigns || [];
  if (!rows.length) {
    campaigns.append(emptyBlock('No campaigns', 'No UTM parameters were seen in this period.'));
    return;
  }
  const sources = new Map();
  for (const row of rows) {
    const key = row.source || '(none)';
    const current = sources.get(key) || { source: key, pageviews: 0, sessions: 0 };
    current.pageviews += Number(row.pageviews) || 0;
    current.sessions += Number(row.sessions) || 0;
    sources.set(key, current);
  }
  const sourceRows = [...sources.values()].sort((a, b) => b.pageviews - a.pageviews);
  campaigns.append(h('p', { class: 'bars-heading', text: 'Sources' }));
  campaigns.append(barsBlock(sourceRows, { label: row => row.source, value: row => row.pageviews }));
  campaigns.append(h('p', { class: 'bars-heading', text: 'Source / medium / campaign' }));
  const columns = [
    { key: 'source', label: 'Source', className: 'col-name', title: row => row.source },
    { key: 'medium', label: 'Medium', className: 'col-name', title: row => row.medium },
    { key: 'campaign', label: 'Campaign', className: 'col-path', title: row => row.campaign },
    { key: 'pageviews', label: 'Pageviews', className: 'num col-num' },
    { key: 'sessions', label: 'Sessions', className: 'num col-num' },
  ];
  campaigns.append(dataTable(columns, rows));
}

/* Events */

async function loadEvents() {
  const epoch = state.epoch;
  const table = $('#events-table');
  const recent = $('#events-recent');
  if (!table || !recent) return;
  skeleton(table, 5);
  skeleton(recent, 5);
  const [eventsResult, recentResult] = await Promise.allSettled([
    api(reportPath(state.site.public_id, 'events', reportParams({ limit: 50 }))),
    api(reportPath(state.site.public_id, 'recent', reportParams({ limit: 25 }))),
  ]);
  if (epoch !== state.epoch) return;
  endSkeleton(table);
  endSkeleton(recent);
  clear(table);
  if (eventsResult.status !== 'fulfilled') {
    table.append(errorBlock(friendlyError(eventsResult.reason), retryCurrent));
  } else {
    const rows = eventsResult.value.events || [];
    if (!rows.length) {
      table.append(emptyBlock('No custom events', 'No custom events were tracked in this period.'));
    } else {
      const total = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
      table.append(dataTable([
        { key: 'event_name', label: 'Event', className: 'col-name', title: row => row.event_name },
        { key: 'count', label: 'Count', className: 'num col-num' },
        { key: 'sessions', label: 'Sessions', className: 'num col-num' },
        { key: 'share', label: '% of events', className: 'col-share', render: row => shareCell(row.count, total) },
      ], rows));
    }
  }
  clear(recent);
  if (recentResult.status !== 'fulfilled') {
    recent.append(errorBlock(friendlyError(recentResult.reason), retryCurrent));
    return;
  }
  const events = (recentResult.value.events || []).filter(event => event.event_kind === 'event');
  if (!events.length) {
    recent.append(emptyBlock('No recent events', 'No custom events in this period yet.'));
    return;
  }
  recent.append(dataTable([
    { key: 'time', label: 'Time', className: 'col-time', render: event => formatDateTime(event.received_at_ms) },
    { key: 'name', label: 'Event', className: 'col-name', render: event => event.event_name, title: event => event.event_name },
    { key: 'path', label: 'Page', className: 'col-path', render: event => event.pathname, title: event => event.pathname },
    { key: 'device', label: 'Device', className: 'col-ref', render: event => [event.browser, event.device].filter(Boolean).join(' · ') || '—' },
  ], events));
}

/* Settings */

function setFormDisabled(form, disabled) {
  for (const control of form.querySelectorAll('input, select, button')) control.disabled = disabled;
}

function setNote(id, message, kind = '') {
  const note = $(id);
  if (!note) return;
  note.textContent = message || '';
  note.className = `form-note${kind ? ` is-${kind}` : ''}`;
}

function renderSettings() {
  const site = state.site;
  if (!site || !$('#general-form')) return;
  const canEdit = state.role === 'owner';
  const canSnippet = state.role === 'owner' || state.role === 'editor';

  $('#site-name').value = site.name || '';
  $('#site-slug').value = site.slug || '';
  $('#site-timezone').value = site.timezone || 'UTC';
  $('#site-active').checked = !!site.active;
  $('#site-dnt').checked = !!site.respect_dnt;
  $('#site-gpc').checked = !!site.respect_gpc;
  $('#site-retention').value = site.raw_retention_days || 90;
  setFormDisabled($('#general-form'), !canEdit);
  setFormDisabled($('#privacy-form'), !canEdit);

  const domainForm = $('#domain-form');
  setFormDisabled(domainForm, !canEdit);
  renderSettingsDomains();

  const snippetCard = $('#snippet');
  if (canSnippet) {
    setText(snippetCard, state.data.snippet || '');
    show($('#copy-snippet'), true);
  } else {
    setText(snippetCard, 'The tracking snippet is available to owners and editors.');
    show($('#copy-snippet'), false);
  }

  const memberForm = $('#member-form');
  setFormDisabled(memberForm, !canEdit);
  show(memberForm, canEdit);
  renderSettingsMembers();
  renderRoleNote();
}

function renderSettingsDomains() {
  const container = $('#domain-list');
  if (!container) return;
  clear(container);
  if (!state.domains.length) {
    container.append(emptyBlock('No domains', 'Add the hostname where this Site is served.'));
    return;
  }
  const canEdit = state.role === 'owner';
  for (const domain of state.domains) {
    container.append(h('div', { class: 'list-row' }, [
      h('span', { class: 'list-name', text: domain.hostname, title: domain.hostname }),
      h('span', { class: `badge${domain.kind === 'primary' ? ' is-primary' : ''}`, text: domain.kind }),
      h('span', { class: `badge${domain.active ? '' : ' is-off'}`, text: domain.active ? 'active' : 'inactive' }),
      domain.active && canEdit
        ? h('button', {
          type: 'button',
          class: 'button button-ghost',
          text: 'Deactivate',
          onclick: event => deactivateDomain(domain.hostname, event.currentTarget),
        })
        : null,
    ]));
  }
}

function renderSettingsMembers() {
  const container = $('#member-list');
  if (!container) return;
  clear(container);
  const canEdit = state.role === 'owner';
  if (!canEdit) {
    container.append(emptyBlock('Access', 'Only owners can manage Site access.'));
    return;
  }
  const members = state.data.members || [];
  if (!members.length) {
    container.append(emptyBlock('No members', 'This Site is managed by global CFLab admins only.'));
    return;
  }
  for (const member of members) {
    container.append(h('div', { class: 'list-row' }, [
      h('span', { class: 'list-name', text: member.user_id, title: member.user_id }),
      h('span', { class: 'badge', text: member.role }),
      h('button', {
        type: 'button',
        class: 'button button-ghost',
        text: 'Remove',
        onclick: event => removeMember(member.user_id, event.currentTarget),
      }),
    ]));
  }
}

async function loadSettings() {
  renderSettings();
  const epoch = state.epoch;
  const canSnippet = state.role === 'owner' || state.role === 'editor';
  const canEdit = state.role === 'owner';
  const requests = [
    canSnippet ? api(`/api/sites/${encodeURIComponent(state.site.public_id)}/snippet`) : Promise.resolve(null),
    canEdit ? api(`/api/sites/${encodeURIComponent(state.site.public_id)}/members`) : Promise.resolve(null),
  ];
  const [snippetResult, membersResult] = await Promise.allSettled(requests);
  if (epoch !== state.epoch) return;
  if (snippetResult.status === 'fulfilled' && snippetResult.value) {
    state.data.snippet = snippetResult.value.snippet || '';
    setText($('#snippet'), state.data.snippet);
  } else if (snippetResult.status === 'rejected' && canSnippet) {
    setText($('#snippet'), friendlyError(snippetResult.reason));
  }
  if (membersResult.status === 'fulfilled' && membersResult.value) {
    state.data.members = membersResult.value.members || [];
    renderSettingsMembers();
  } else if (membersResult.status === 'rejected' && canEdit) {
    clear($('#member-list'));
    $('#member-list').append(errorBlock(friendlyError(membersResult.reason), () => loadActiveTab({ force: true })));
  }
}

async function saveGeneral(event) {
  event.preventDefault();
  const button = $('#general-form button[type="submit"]');
  button.disabled = true;
  setNote('#general-note', 'Saving…');
  try {
    const data = await api(`/api/sites/${encodeURIComponent(state.site.public_id)}`, {
      method: 'PATCH',
      body: {
        name: $('#site-name').value,
        slug: $('#site-slug').value,
        timezone: $('#site-timezone').value,
        active: $('#site-active').checked,
      },
    });
    state.site = data.site;
    state.role = data.site.role || state.role;
    const listed = state.sites.find(site => site.public_id === state.site.public_id);
    if (listed) listed.name = state.site.name;
    renderSiteOptions();
    setNote('#general-note', 'Saved', 'ok');
  } catch (error) {
    setNote('#general-note', friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function savePrivacy(event) {
  event.preventDefault();
  const button = $('#privacy-form button[type="submit"]');
  button.disabled = true;
  setNote('#privacy-note', 'Saving…');
  try {
    const data = await api(`/api/sites/${encodeURIComponent(state.site.public_id)}`, {
      method: 'PATCH',
      body: {
        respect_dnt: $('#site-dnt').checked,
        respect_gpc: $('#site-gpc').checked,
        raw_retention_days: Number($('#site-retention').value),
      },
    });
    state.site = data.site;
    setNote('#privacy-note', 'Saved', 'ok');
  } catch (error) {
    setNote('#privacy-note', friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function addDomain(event) {
  event.preventDefault();
  const button = $('#domain-form button[type="submit"]');
  button.disabled = true;
  setNote('#domain-note', 'Adding…');
  try {
    await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/domains`, {
      method: 'POST',
      body: { hostname: $('#domain-hostname').value, kind: $('#domain-kind').value },
    });
    $('#domain-hostname').value = '';
    await refreshDomains();
    setNote('#domain-note', 'Domain added', 'ok');
  } catch (error) {
    setNote('#domain-note', friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function deactivateDomain(hostname, button) {
  button.disabled = true;
  setNote('#domain-note', 'Deactivating…');
  try {
    await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/domains/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
    await refreshDomains();
    setNote('#domain-note', 'Domain deactivated', 'ok');
  } catch (error) {
    setNote('#domain-note', friendlyError(error), 'error');
    button.disabled = false;
  }
}

async function refreshDomains() {
  const detail = await api(`/api/sites/${encodeURIComponent(state.site.public_id)}`);
  state.site = detail.site;
  state.role = detail.site.role || state.role;
  state.domains = detail.domains || [];
  renderDomainOptions();
  renderSettingsDomains();
}

async function saveMember(event) {
  event.preventDefault();
  const button = $('#member-form button[type="submit"]');
  button.disabled = true;
  setNote('#member-note', 'Saving…');
  try {
    await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/members/${encodeURIComponent($('#member-user').value)}`, {
      method: 'PUT',
      body: { role: $('#member-role').value },
    });
    $('#member-user').value = '';
    const data = await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/members`);
    state.data.members = data.members || [];
    renderSettingsMembers();
    setNote('#member-note', 'Member saved', 'ok');
  } catch (error) {
    setNote('#member-note', friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function removeMember(userId, button) {
  button.disabled = true;
  setNote('#member-note', 'Removing…');
  try {
    await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    const data = await api(`/api/sites/${encodeURIComponent(state.site.public_id)}/members`);
    state.data.members = data.members || [];
    renderSettingsMembers();
    setNote('#member-note', 'Member removed', 'ok');
  } catch (error) {
    setNote('#member-note', friendlyError(error), 'error');
    button.disabled = false;
  }
}

async function copySnippet(button) {
  const text = state.data.snippet || '';
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    flash(button, 'Copied');
    setNote('#snippet-note', 'Snippet copied to clipboard', 'ok');
  } catch {
    flash(button, 'Copy failed');
    setNote('#snippet-note', 'Copy failed. Select the snippet and copy it manually.', 'error');
  }
}

/* New site dialog */

function openNewSiteDialog() {
  const dialog = $('#new-site-dialog');
  setText($('#new-site-error'), '');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else if (dialog) dialog.setAttribute('open', '');
}

function closeNewSiteDialog() {
  const dialog = $('#new-site-dialog');
  if (dialog && typeof dialog.close === 'function') dialog.close();
  else if (dialog) dialog.removeAttribute('open');
}

async function createSite(event) {
  event.preventDefault();
  const button = $('#new-site-form button[type="submit"]');
  button.disabled = true;
  setText($('#new-site-error'), '');
  try {
    const data = await api('/api/sites', {
      method: 'POST',
      body: {
        name: $('#new-site-name').value,
        domain: $('#new-site-domain').value || undefined,
        timezone: $('#new-site-timezone').value || undefined,
      },
    });
    closeNewSiteDialog();
    $('#new-site-form').reset();
    $('#new-site-timezone').value = 'UTC';
    const sites = await api('/api/sites');
    state.sites = sites.sites || [];
    renderSiteOptions();
    await selectSite(data.site.public_id);
  } catch (error) {
    setText($('#new-site-error'), friendlyError(error));
  } finally {
    button.disabled = false;
  }
}

/* Wiring */

function wire() {
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#login-submit');
    button.disabled = true;
    setText($('#login-error'), '');
    try {
      await signIn($('#login-email').value, $('#login-password').value);
      $('#login-password').value = '';
      showApp();
      await loadSitesAndStart();
    } catch (error) {
      setText($('#login-error'), error.message || 'Unable to sign in.');
    } finally {
      button.disabled = false;
    }
  });

  $('#sign-out').addEventListener('click', async () => {
    try {
      await fetch(`${authBase()}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } });
    } catch { /* best effort */ }
    signOutLocal();
    showLogin('');
  });

  $('#site-select').addEventListener('change', event => {
    state.domain = '';
    selectSite(event.target.value);
  });

  $('#domain-select').addEventListener('change', event => {
    state.domain = event.target.value;
    state.loaded = {};
    updateUrl();
    loadActiveTab({ force: true });
  });

  $('#range-select').addEventListener('change', event => {
    state.range = event.target.value;
    if (state.range !== 'custom') {
      state.from = '';
      state.to = '';
    }
    show($('#custom-range'), state.range === 'custom');
    if (state.range === 'custom') {
      const today = new Date().toISOString().slice(0, 10);
      $('#range-to').value = state.to || today;
      $('#range-from').value = state.from || today;
      return;
    }
    state.loaded = {};
    updateUrl();
    loadActiveTab({ force: true });
  });

  $('#range-apply').addEventListener('click', () => {
    const from = $('#range-from').value;
    const to = $('#range-to').value;
    if (!from || !to || from > to) {
      setNote('#range-note', 'Choose a valid range where From is before To.', 'error');
      return;
    }
    setNote('#range-note', '');
    state.range = 'custom';
    state.from = from;
    state.to = to;
    state.loaded = {};
    updateUrl();
    loadActiveTab({ force: true });
  });

  $('#refresh').addEventListener('click', () => {
    state.loaded = {};
    loadActiveTab({ force: true });
  });

  $('#new-site').addEventListener('click', () => openNewSiteDialog());
  $('#new-site-cancel').addEventListener('click', () => closeNewSiteDialog());
  $('#new-site-form').addEventListener('submit', createSite);

  $('#general-form').addEventListener('submit', saveGeneral);
  $('#privacy-form').addEventListener('submit', savePrivacy);
  $('#domain-form').addEventListener('submit', addDomain);
  $('#member-form').addEventListener('submit', saveMember);
  $('#copy-snippet').addEventListener('click', event => copySnippet(event.currentTarget));

  document.addEventListener('click', event => {
    const link = event.target && event.target.closest ? event.target.closest('[data-tab-link]') : null;
    if (link) {
      event.preventDefault();
      setTab(link.getAttribute('data-tab-link'));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startLive();
      refreshLive();
    } else {
      stopLive();
    }
  });

  window.addEventListener('popstate', () => {
    const next = stateFromSearch(location.search);
    state.tab = next.tab;
    state.range = next.range;
    state.from = next.from;
    state.to = next.to;
    state.domain = next.domain;
    state.loaded = {};
    renderRangeOptions();
    renderDomainOptions();
    if (next.site && state.site && next.site !== state.site.public_id) {
      selectSite(next.site);
      return;
    }
    setTab(next.tab, { force: true });
  });
}

export function init() {
  const initial = stateFromSearch(location.search);
  state.range = initial.range;
  state.from = initial.from;
  state.to = initial.to;
  state.domain = initial.domain;
  state.tab = initial.tab;
  wire();
  renderTabs();
  renderMetricSwitch();
  renderRangeOptions();
  setTab(state.tab);
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored) {
    state.token = stored;
    showApp();
    loadSitesAndStart();
  } else {
    showLogin('');
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}
