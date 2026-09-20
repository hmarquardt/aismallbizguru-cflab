import { formatDateTime, formatNumber, formatPercent, barWidth, share } from './lib.js';

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node, visible) {
  if (node) node.hidden = !visible;
}

export function setText(node, value) {
  if (node) node.textContent = value == null ? '' : String(value);
}

export function h(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') throw new Error('h() does not accept raw html');
    else if (key === 'style') Object.assign(element.style, value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'object' && child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function skeleton(container, rows = 5, variant = 'bars') {
  if (!container) return;
  clear(container);
  container.setAttribute('aria-busy', 'true');
  for (let index = 0; index < rows; index += 1) {
    if (variant === 'kpi') {
      container.append(h('div', { class: 'skeleton skeleton-kpi' }));
    } else if (variant === 'chart') {
      container.append(h('div', { class: 'skeleton skeleton-chart' }));
    } else {
      container.append(h('div', { class: 'skeleton skeleton-row', style: { width: `${100 - (index % 3) * 12}%` } }));
    }
  }
}

export function endSkeleton(container) {
  if (container) container.removeAttribute('aria-busy');
}

export function errorBlock(message, onRetry) {
  return h('div', { class: 'state-block state-error', role: 'alert' }, [
    h('p', { text: message }),
    onRetry ? h('button', { type: 'button', class: 'button button-secondary', text: 'Retry', onclick: onRetry }) : null,
  ]);
}

export function emptyBlock(title, message, actionLabel, onAction) {
  return h('div', { class: 'state-block' }, [
    h('p', { class: 'state-title', text: title }),
    message ? h('p', { class: 'state-message', text: message }) : null,
    actionLabel && onAction ? h('button', { type: 'button', class: 'button', text: actionLabel, onclick: onAction }) : null,
  ]);
}

export function renderKpis(container, metrics) {
  if (!container) return;
  clear(container);
  for (const metric of metrics) {
    const delta = metric.delta && metric.delta.available
      ? h('span', {
        class: `kpi-delta ${metric.delta.pct > 0 ? 'is-up' : metric.delta.pct < 0 ? 'is-down' : 'is-flat'}`,
        text: `${metric.delta.pct > 0 ? '+' : ''}${metric.delta.pct}%`,
        title: 'Compared with the previous period',
      })
      : h('span', { class: 'kpi-delta is-muted', text: 'No prior data' });
    container.append(h('div', { class: 'kpi' }, [
      h('span', { class: 'kpi-label', text: metric.label }),
      h('span', { class: 'kpi-value', text: metric.formatted, title: formatNumber(metric.value) }),
      delta,
    ]));
  }
}

export function barsBlock(items, options = {}) {
  const { label, value, secondary, title, max, onSelect, emptyMessage = 'No data yet for this period.' } = options;
  if (!items || !items.length) return emptyBlock('No data', emptyMessage);
  const peak = max ?? items.reduce((top, item) => Math.max(top, Number(value(item)) || 0), 0);
  const list = h('div', { class: 'bars' });
  for (const item of items) {
    const itemValue = Number(value(item)) || 0;
    const row = h('div', {
      class: `bar-row${onSelect ? ' is-selectable' : ''}`,
      title: title ? title(item) : undefined,
      role: onSelect ? 'button' : undefined,
      tabindex: onSelect ? '0' : undefined,
      onclick: onSelect ? () => onSelect(item) : undefined,
      onkeydown: onSelect ? event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item); }
      } : undefined,
    }, [
      h('span', { class: 'bar-label', text: label(item), title: title ? title(item) : label(item) }),
      h('span', { class: 'bar-track' }, [
        h('span', { class: 'bar-fill', style: { width: `${barWidth(itemValue, peak)}%` } }),
      ]),
      h('span', { class: 'bar-value', text: formatNumber(itemValue) }),
      secondary ? h('span', { class: 'bar-secondary', text: secondary(item) }) : null,
    ]);
    list.append(row);
  }
  return list;
}

export function dataTable(columns, rows, options = {}) {
  const { emptyMessage = 'No data yet for this period.', total } = options;
  if (!rows || !rows.length) return emptyBlock('No data', emptyMessage);
  const table = h('table', { class: 'data-table' }, [
    h('thead', {}, [h('tr', {}, columns.map(column => h('th', { class: column.className, text: column.label })))]),
    h('tbody', {}, rows.map(row => h('tr', {}, columns.map(column => {
      const content = column.render ? column.render(row) : row[column.key];
      const cell = h('td', { class: column.className });
      if (content && typeof content === 'object' && content.nodeType) cell.append(content);
      else cell.textContent = content == null ? '' : String(content);
      if (column.title) cell.title = column.title(row);
      return cell;
    })))),
  ]);
  const wrapper = h('div', { class: 'table-wrap' }, [table]);
  if (total !== undefined) {
    wrapper.append(h('p', { class: 'table-note', text: `${formatNumber(rows.length)} of ${formatNumber(total)} rows` }));
  }
  return wrapper;
}

export function shareCell(value, total, options = {}) {
  return h('span', { class: 'share-cell' }, [
    h('span', { class: 'share-track' }, [h('span', { class: 'share-fill', style: { width: `${barWidth(value, total)}%` } })]),
    h('span', { class: 'share-value', text: formatPercent(share(value, total)) }),
  ]);
}

export function recentTable(events) {
  if (!events || !events.length) return emptyBlock('No activity', 'No events in this period yet.');
  const columns = [
    { key: 'time', label: 'Time', className: 'col-time' },
    { key: 'name', label: 'Event', className: 'col-name' },
    { key: 'path', label: 'Page', className: 'col-path' },
  ];
  const rows = events.map(event => ({
    time: formatDateTime(event.received_at_ms),
    name: event.event_kind === 'event' ? event.event_name : 'pageview',
    path: event.pathname,
  }));
  return dataTable(columns, rows, { emptyMessage: 'No activity in this period yet.' });
}

export function flash(button, message, timeout = 1800) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = message;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, timeout);
}
