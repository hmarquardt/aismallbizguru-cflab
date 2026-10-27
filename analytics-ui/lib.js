// Pure dashboard logic: no DOM, no network, no Chart.js. Kept importable from
// Node so it can be unit-tested without a browser.

export const RANGES = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' },
];

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pages', label: 'Pages' },
  { id: 'acquisition', label: 'Acquisition' },
  { id: 'search', label: 'Search' },
  { id: 'events', label: 'Events' },
  { id: 'settings', label: 'Settings' },
];

// Search Console has two metrics worth plotting; CTR and average position are
// shown as cards and in the table because neither is additive over days.
export const SEARCH_METRICS = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' },
];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function shiftDay(day, delta) {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date));
  shifted.setUTCDate(shifted.getUTCDate() + delta);
  return shifted.toISOString().slice(0, 10);
}

export function validDay(value) {
  return typeof value === 'string' && DAY_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function daySpan(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function bucketForSpan(days) {
  return days <= 2 ? 'hour' : 'day';
}

export function rangeFor(value, now = new Date(), customFrom, customTo) {
  const today = now.toISOString().slice(0, 10);
  const preset = (from, days, label) => ({ value, from, to: today, days, bucket: bucketForSpan(days), label });
  if (value === 'today') return preset(today, 1, 'Today');
  if (value === '7d') return preset(shiftDay(today, -6), 7, 'Last 7 days');
  if (value === '90d') return preset(shiftDay(today, -89), 90, 'Last 90 days');
  if (value === 'custom' && validDay(customFrom) && validDay(customTo) && customFrom <= customTo) {
    const days = daySpan(customFrom, customTo);
    return { value: 'custom', from: customFrom, to: customTo, days, bucket: bucketForSpan(days), label: 'Custom range' };
  }
  return { value: '30d', from: shiftDay(today, -29), to: today, days: 30, bucket: 'day', label: 'Last 30 days' };
}

export function previousRange(range) {
  const to = shiftDay(range.from, -1);
  return { from: shiftDay(to, -(range.days - 1)), to, days: range.days };
}

export function delta(current, previous) {
  const next = Number(current);
  const prior = Number(previous);
  if (!Number.isFinite(next) || !Number.isFinite(prior) || prior <= 0) return { available: false, pct: 0 };
  return { available: true, pct: Math.round(((next - prior) / prior) * 1000) / 10 };
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

export function formatCompact(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

export function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 10) / 10}%`;
}

export function share(value, total) {
  const whole = Number(total) || 0;
  return whole > 0 ? ((Number(value) || 0) / whole) * 100 : 0;
}

export function barWidth(value, max) {
  const peak = Number(max) || 0;
  const current = Number(value) || 0;
  if (peak <= 0 || current <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((current / peak) * 100)));
}

// KPI deltas come from a second summary request for the immediately preceding
// equal-length period. No previous data means no delta is shown.
export function metricCards(summary, previous) {
  const current = summary || {};
  const prior = previous || {};
  const metrics = [
    { key: 'pageviews', label: 'Pageviews', value: Number(current.pageviews) || 0 },
    { key: 'sessions', label: 'Sessions', value: Number(current.sessions) || 0 },
    { key: 'events', label: 'Events', value: Number(current.events) || 0 },
    { key: 'pages_per_session', label: 'Pages / session', value: Number(current.pages_per_session) || 0, raw: true },
  ];
  return metrics.map(metric => {
    const comparison = prior[metric.key] === undefined ? { available: false, pct: 0 } : delta(metric.value, prior[metric.key]);
    return {
      ...metric,
      formatted: metric.raw ? String(Math.round(metric.value * 100) / 100) : formatNumber(metric.value),
      delta: comparison,
    };
  });
}

export function reportQuery(params = {}) {
  const query = new URLSearchParams();
  for (const key of ['from', 'to', 'domain', 'limit', 'bucket', 'property']) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export function reportPath(siteRef, report, params = {}) {
  const query = reportQuery(params);
  return `/api/sites/${encodeURIComponent(siteRef)}/${report}${query ? `?${query}` : ''}`;
}

export function seriesForMetric(points, metric) {
  return (points || []).map(point => ({
    label: point.date,
    value: Number(point[metric]) || 0,
  }));
}

export function pageTotal(pages) {
  return (pages || []).reduce((total, page) => total + (Number(page.pageviews) || 0), 0);
}

export function domainChoices(domains) {
  return (domains || [])
    .filter(domain => domain && domain.hostname)
    .slice()
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'primary' ? -1 : 1;
      return a.hostname.localeCompare(b.hostname);
    })
    .map(domain => ({
      hostname: domain.hostname,
      label: domain.active ? domain.hostname : `${domain.hostname} (inactive)`,
      kind: domain.kind,
      active: !!domain.active,
    }));
}

export function validTab(value) {
  return TABS.some(tab => tab.id === value) ? value : 'overview';
}

export function formatBucketLabel(bucket, value) {
  if (typeof value !== 'string' || !value) return '';
  if (bucket === 'hour') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

export function formatDateTime(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function stateFromSearch(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const range = ['today', '7d', '30d', '90d', 'custom'].includes(params.get('range')) ? params.get('range') : '30d';
  return {
    site: params.get('site') || '',
    domain: params.get('domain') || '',
    range,
    from: validDay(params.get('from')) ? params.get('from') : '',
    to: validDay(params.get('to')) ? params.get('to') : '',
    tab: validTab(params.get('tab') || 'overview'),
  };
}

export function searchFromState(state) {
  const params = new URLSearchParams();
  if (state.site) params.set('site', state.site);
  if (state.domain) params.set('domain', state.domain);
  if (state.range && state.range !== '30d') params.set('range', state.range);
  if (state.range === 'custom') {
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
  }
  if (state.tab && state.tab !== 'overview') params.set('tab', state.tab);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/* Search Console ------------------------------------------------------------- */

// Google returns CTR as a fraction and average position as a rank (lower is
// better). Both are formatted explicitly so a zero CTR is never shown as a bare
// number and a missing position is never invented as 0.
export function formatCtr(value) {
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  return `${Math.round(fraction * 1000) / 10}%`;
}

export function formatPosition(value) {
  const position = Number(value);
  if (value === null || value === undefined || !Number.isFinite(position) || position <= 0) return '—';
  return (Math.round(position * 10) / 10).toFixed(1);
}

// Average position improves when it gets smaller, so its delta is expressed in
// positions gained (positive = moved up) instead of a percentage of a rank.
function positionDelta(current, previous) {
  const next = Number(current);
  const prior = Number(previous);
  if (!Number.isFinite(next) || !Number.isFinite(prior) || next <= 0 || prior <= 0) {
    return { available: false, pct: 0, deltaText: 'No prior data' };
  }
  const change = Math.round((prior - next) * 10) / 10;
  const pct = Math.round((change / prior) * 1000) / 10;
  return {
    available: true,
    pct,
    deltaText: change === 0 ? 'No change' : `${change > 0 ? '+' : ''}${change} places`,
  };
}

function ctrDelta(current, previous) {
  const next = Number(current) || 0;
  const prior = Number(previous) || 0;
  if (prior <= 0) return { available: false, pct: 0, deltaText: 'No prior data' };
  const pct = Math.round(((next - prior) / prior) * 1000) / 10;
  const points = Math.round((next - prior) * 1000) / 10;
  return {
    available: true,
    pct,
    deltaText: `${points > 0 ? '+' : ''}${points} pp`,
  };
}

export function searchMetricCards(totals = {}, previous = {}) {
  return [
    {
      label: 'Impressions',
      value: Number(totals.impressions) || 0,
      formatted: formatNumber(totals.impressions),
      delta: delta(totals.impressions, previous.impressions),
    },
    {
      label: 'Clicks',
      value: Number(totals.clicks) || 0,
      formatted: formatNumber(totals.clicks),
      delta: delta(totals.clicks, previous.clicks),
    },
    {
      label: 'CTR',
      value: Number(totals.ctr) || 0,
      formatted: formatCtr(totals.ctr),
      delta: ctrDelta(totals.ctr, previous.ctr),
    },
    {
      label: 'Avg position',
      value: Number(totals.position) || 0,
      formatted: formatPosition(totals.position),
      delta: positionDelta(totals.position, previous.position),
    },
  ];
}

export function searchSeries(points, metric) {
  return (points || []).map(point => ({
    label: point.date,
    value: Number(point[metric]) || 0,
  }));
}

// Search Console only reports completed days. "Last 7 days" therefore means the
// seven most recent days Google has data for, keeping the requested window length
// instead of silently showing an empty final day.
export function searchRange(range, newestReportableDay) {
  const fallback = { from: range.from, to: range.to, days: range.days };
  if (!validDay(newestReportableDay) || !validDay(range.to)) return fallback;
  const to = range.to > newestReportableDay ? newestReportableDay : range.to;
  return { from: shiftDay(to, -(range.days - 1)), to, days: range.days };
}

export function searchPropertyChoices(properties) {
  return (properties || []).map(property => ({
    value: property.property,
    label: `${property.label} (${property.property})`,
    mapped: !!property.mapped,
  }));
}

// A single place that decides what the Search tab should say. Having no traffic
// is a normal state for a newly connected property; a missing mapping, missing
// credentials, and a failed synchronization are different states with different
// remedies, and none of them is presented as zero traffic.
export function searchState({ status, summary } = {}) {
  if (!status) return { code: 'unavailable', title: 'Search Console status unavailable', message: 'Reload to try again.' };
  if (!status.properties || !status.properties.length) {
    return {
      code: 'not_mapped',
      title: 'No Search Console property is mapped to this Site',
      message: 'Search Console data is collected per property. Add this Site\'s domain as a verified Search Console property and map it in the CFLab property list.',
    };
  }
  if (status.configured === false) {
    return {
      code: 'not_configured',
      title: 'Search Console credentials are not configured',
      message: 'The server has no Google service account. Collection cannot run until an administrator installs it; no search data is shown.',
    };
  }
  const failed = (status.properties || []).find(property => property.last_error_code);
  if (!status.sync || !status.sync.last_success_at) {
    return {
      code: failed ? 'sync_failed' : 'not_synced',
      title: failed ? 'Search Console synchronization failed' : 'Waiting for the first synchronization',
      message: failed
        ? `Google reported ${failed.last_error_code} for ${failed.property}. The next scheduled run retries automatically.`
        : 'The hourly collector has not completed a run for this property yet. Data appears after the first successful synchronization.',
    };
  }
  if (summary && Number(summary.totals?.impressions) === 0 && Number(summary.totals?.clicks) === 0) {
    const covered = Number(summary.freshness?.covered_days) || 0;
    return {
      code: 'no_traffic',
      title: 'No search traffic reported for this period',
      message: covered > 0
        ? `Google reported no impressions for ${formatNumber(covered)} collected day(s) in this range. New properties can take a few days to report, and a site with no indexed pages has nothing to show.`
        : 'No days in this range have been collected yet. The collector fills recent days first and then backfills history.',
    };
  }
  return { code: 'ready', title: '', message: '' };
}
