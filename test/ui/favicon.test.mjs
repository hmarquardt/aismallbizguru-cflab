import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const UI_SOURCE = readFileSync(new URL('../../src/ui.ts', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../../analytics-ui/index.html', import.meta.url), 'utf8');

// Reproduces the exact declaration built by src/ui.ts (FAVICON_SVG + FAVICON)
// so the analytics dashboard cannot drift from the CFLab flask favicon.
function cflabFavicon() {
  const match = /const FAVICON_SVG = ('[^']*');/.exec(UI_SOURCE);
  assert.ok(match, 'FAVICON_SVG not found in src/ui.ts');
  const svg = new Function(`return ${match[1]}`)();
  return '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,'
    + encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27')
    + '">';
}

test('analytics dashboard reuses the exact CFLab inline flask favicon', () => {
  const expected = cflabFavicon();
  assert.ok(INDEX_HTML.includes(expected), 'analytics-ui/index.html must contain the exact CFLab favicon declaration');
  assert.equal((INDEX_HTML.match(/rel="icon"/g) || []).length, 1, 'exactly one icon declaration expected');

  const href = /<link rel="icon"[^>]*href="([^"]+)"/.exec(INDEX_HTML)[1];
  assert.ok(href.startsWith('data:image/svg+xml,'), 'favicon must be an inline SVG data URI');
  const decoded = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  assert.ok(decoded.includes('clipPath id="flask"'), 'decoded favicon must contain the flask artwork');
  assert.ok(!INDEX_HTML.includes('/favicon.svg') && !INDEX_HTML.includes('/favicon.ico'), 'no favicon asset references allowed');
});

test('no favicon asset is shipped in the analytics-ui directory', () => {
  const files = readdirSync(new URL('../../analytics-ui/', import.meta.url));
  assert.equal(files.some(name => /^favicon\./i.test(name)), false);
});
