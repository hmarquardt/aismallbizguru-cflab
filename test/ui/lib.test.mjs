import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftDay, daySpan, bucketForSpan, rangeFor, previousRange, delta, formatNumber, formatPercent,
  share, barWidth, metricCards, reportQuery, reportPath, seriesForMetric, pageTotal,
  domainChoices, validTab, formatBucketLabel, stateFromSearch, searchFromState,
} from '../../analytics-ui/lib.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

test('range presets compute UTC calendar windows and granularity', () => {
  assert.deepEqual(rangeFor('today', NOW), { value: 'today', from: '2026-09-20', to: '2026-09-20', days: 1, bucket: 'hour', label: 'Today' });
  const week = rangeFor('7d', NOW);
  assert.deepEqual([week.from, week.to, week.days, week.bucket], ['2026-09-14', '2026-09-20', 7, 'day']);
  const month = rangeFor('30d', NOW);
  assert.deepEqual([month.from, month.days], ['2026-08-22', 30]);
  const quarter = rangeFor('90d', NOW);
  assert.deepEqual([quarter.from, quarter.days], ['2026-06-23', 90]);
});

test('custom ranges validate and short windows switch to hourly buckets', () => {
  const custom = rangeFor('custom', NOW, '2026-09-01', '2026-09-02');
  assert.deepEqual([custom.from, custom.to, custom.days, custom.bucket], ['2026-09-01', '2026-09-02', 2, 'hour']);
  assert.equal(rangeFor('custom', NOW, '2026-09-10', '2026-09-01').value, '30d');
  assert.equal(rangeFor('custom', NOW, 'bad', '2026-09-01').value, '30d');
  assert.equal(rangeFor('nonsense', NOW).value, '30d');
});

test('previousRange is the equal-length window immediately before', () => {
  assert.deepEqual(previousRange({ from: '2026-09-14', to: '2026-09-20', days: 7 }), { from: '2026-09-07', to: '2026-09-13', days: 7 });
  assert.deepEqual(previousRange({ from: '2026-09-20', to: '2026-09-20', days: 1 }), { from: '2026-09-19', to: '2026-09-19', days: 1 });
});

test('delta only reports a comparison when prior data exists', () => {
  assert.deepEqual(delta(10, 0), { available: false, pct: 0 });
  assert.deepEqual(delta(10, 8), { available: true, pct: 25 });
  assert.deepEqual(delta(0, 8), { available: true, pct: -100 });
  assert.deepEqual(delta(Number.NaN, 8), { available: false, pct: 0 });
});

test('metricCards formats values and attaches real previous-period deltas', () => {
  const cards = metricCards(
    { pageviews: 12481, sessions: 8204, events: 314, pages_per_session: 1.52 },
    { pageviews: 10000, sessions: 8000, events: 314, pages_per_session: 1.5 },
  );
  assert.deepEqual(cards.map(card => card.label), ['Pageviews', 'Sessions', 'Events', 'Pages / session']);
  assert.equal(cards[0].formatted, '12,481');
  assert.deepEqual(cards[0].delta, { available: true, pct: 24.8 });
  assert.deepEqual(cards[1].delta, { available: true, pct: 2.6 });
  assert.deepEqual(cards[2].delta, { available: true, pct: 0 });
  assert.equal(cards[3].formatted, '1.52');
  assert.deepEqual(metricCards({ pageviews: 5 }, {})[0].delta, { available: false, pct: 0 });
});

test('reportPath builds encoded, ordered site-scoped requests', () => {
  assert.equal(
    reportPath('as_abc', 'summary', { from: '2026-09-01', to: '2026-09-07', domain: 'example.com' }),
    '/api/sites/as_abc/summary?from=2026-09-01&to=2026-09-07&domain=example.com',
  );
  assert.equal(reportPath('as_abc', 'live', { domain: '' }), '/api/sites/as_abc/live');
  assert.equal(reportPath('as_abc', 'timeseries', { from: 'a', to: 'b', bucket: 'hour', limit: 6 }), '/api/sites/as_abc/timeseries?from=a&to=b&limit=6&bucket=hour');
  assert.equal(reportQuery({ from: 'a', to: 'b', domain: undefined }), 'from=a&to=b');
});

test('seriesForMetric maps API points to chart values', () => {
  const points = [
    { date: '2026-09-19', pageviews: 10, sessions: 4, events: 1 },
    { date: '2026-09-20', pageviews: 12, sessions: 5, events: 2 },
  ];
  assert.deepEqual(seriesForMetric(points, 'pageviews'), [
    { label: '2026-09-19', value: 10 },
    { label: '2026-09-20', value: 12 },
  ]);
  assert.deepEqual(seriesForMetric(undefined, 'events'), []);
});

test('bar widths and shares are bounded and safe', () => {
  assert.equal(barWidth(0, 0), 0);
  assert.equal(barWidth(5, 10), 50);
  assert.equal(barWidth(1, 1000), 2);
  assert.equal(barWidth(20, 10), 100);
  assert.equal(share(25, 100), 25);
  assert.equal(share(5, 0), 0);
  assert.equal(formatPercent(12.345), '12.3%');
  assert.equal(formatNumber(1234567), '1,234,567');
});

test('page totals and domain choices are deterministic', () => {
  assert.equal(pageTotal([{ pageviews: 3 }, { pageviews: 4 }]), 7);
  const choices = domainChoices([
    { hostname: 'www.example.com', kind: 'alias', active: 1 },
    { hostname: 'example.com', kind: 'primary', active: 1 },
    { hostname: 'old.example.com', kind: 'alias', active: 0 },
  ]);
  assert.deepEqual(choices.map(choice => choice.hostname), ['example.com', 'old.example.com', 'www.example.com']);
  assert.equal(choices[1].label, 'old.example.com (inactive)');
});

test('tabs, bucket labels, and URL state round-trip', () => {
  assert.equal(validTab('pages'), 'pages');
  assert.equal(validTab('bogus'), 'overview');
  assert.equal(formatBucketLabel('day', '2026-09-20'), 'Sep 20');
  assert.match(formatBucketLabel('hour', '2026-09-20T14:00:00Z'), /Sep 20.*2:00 PM/);

  const parsed = stateFromSearch('?site=as_x&domain=example.com&range=custom&from=2026-09-01&to=2026-09-05&tab=events');
  assert.deepEqual(parsed, { site: 'as_x', domain: 'example.com', range: 'custom', from: '2026-09-01', to: '2026-09-05', tab: 'events' });
  assert.equal(searchFromState(parsed), '?site=as_x&domain=example.com&range=custom&from=2026-09-01&to=2026-09-05&tab=events');
  assert.equal(searchFromState({ site: 'as_x', domain: '', range: '30d', from: '', to: '', tab: 'overview' }), '?site=as_x');
  assert.equal(searchFromState({ site: '', domain: '', range: '30d', from: '', to: '', tab: 'overview' }), '');
  assert.equal(stateFromSearch('?range=nope&tab=nope').range, '30d');
});

test('day helpers are stable across month boundaries', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(daySpan('2026-09-01', '2026-09-30'), 30);
  assert.equal(bucketForSpan(2), 'hour');
  assert.equal(bucketForSpan(3), 'day');
});
