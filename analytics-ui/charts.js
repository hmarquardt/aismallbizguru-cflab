import { formatCompact, formatNumber } from './lib.js';

const instances = new Map();
const DONUT_COLORS = ['#2563eb', '#0ea5e9', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b'];

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

export function chartsAvailable() {
  return typeof window !== 'undefined' && typeof window.Chart === 'function';
}

function contextFor(canvas) {
  try {
    return typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    return null;
  }
}

export function renderTimeseries(canvas, series, options = {}) {
  if (!chartsAvailable() || !canvas || !series) return false;
  const Chart = window.Chart;
  destroy('timeseries-chart');
  const instance = new Chart(contextFor(canvas), {
    type: 'line',
    data: {
      labels: series.map(point => point.label),
      datasets: [{
        data: series.map(point => point.value),
        borderColor: cssVar('--chart-line', '#2563eb'),
        backgroundColor: cssVar('--chart-fill', 'rgba(37, 99, 235, 0.12)'),
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        pointHitRadius: 14,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: items => (items[0] ? String(items[0].label) : ''),
            label: item => `${options.metricLabel || 'Value'}: ${formatNumber(item.parsed.y || 0)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: cssVar('--muted', '#64748b'), maxTicksLimit: 8, maxRotation: 0, autoSkip: true },
        },
        y: {
          beginAtZero: true,
          grid: { color: cssVar('--chart-grid', 'rgba(148, 163, 184, 0.2)') },
          border: { display: false },
          ticks: { color: cssVar('--muted', '#64748b'), maxTicksLimit: 5, precision: 0, callback: value => formatCompact(value) },
        },
      },
    },
  });
  instances.set('timeseries-chart', instance);
  return true;
}

export function renderDeviceBreakdown(canvas, devices) {
  if (!chartsAvailable() || !canvas || !devices || !devices.length) return false;
  const Chart = window.Chart;
  destroy('device-chart');
  const instance = new Chart(contextFor(canvas), {
    type: 'doughnut',
    data: {
      labels: devices.map(item => item.value),
      datasets: [{
        data: devices.map(item => Number(item.pageviews) || 0),
        backgroundColor: DONUT_COLORS,
        borderColor: cssVar('--card', '#ffffff'),
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: cssVar('--text', '#0f172a'), boxWidth: 10, boxHeight: 10, usePointStyle: true },
        },
        tooltip: {
          callbacks: { label: item => `${item.label}: ${formatNumber(item.parsed || 0)}` },
        },
      },
    },
  });
  instances.set('device-chart', instance);
  return true;
}

export function destroy(key) {
  const instance = instances.get(key);
  if (instance) {
    try { instance.destroy(); } catch { /* already gone */ }
    instances.delete(key);
  }
}

export function destroyAll() {
  for (const key of [...instances.keys()]) destroy(key);
}
