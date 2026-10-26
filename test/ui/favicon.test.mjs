import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import { consolePage } from '../../src/console/page.js';

const UI_SOURCE = readFileSync(new URL('../../src/ui.ts', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../../analytics-ui/index.html', import.meta.url), 'utf8');

// Reproduces the exact declaration built by src/ui.ts (FAVICON_SVG + FAVICON) so
// no CFLab surface can drift from the shared flask favicon.
function cflabFaviconSvg() {
  const match = /const FAVICON_SVG = ('[^']*');/.exec(UI_SOURCE);
  assert.ok(match, 'FAVICON_SVG not found in src/ui.ts');
  return new Function(`return ${match[1]}`)();
}

function dataUri(svg) {
  return 'data:image/svg+xml,'
    + encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27');
}

function cflabFavicon() {
  return '<link rel="icon" type="image/svg+xml" href="' + dataUri(cflabFaviconSvg()) + '">';
}

// The declared artwork: bold orange flask silhouette with a white circuit trace.
test('the CFLab favicon is the orange flask with a white circuit trace', () => {
  const svg = cflabFaviconSvg();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
  assert.ok(svg.includes('fill="#F38020"'), 'flask must be Cloudflare orange');
  assert.ok(svg.includes('stroke="#FFFFFF"'), 'circuit trace must be white');
  assert.ok(svg.includes('fill="#FFFFFF"'), 'circuit node must be white');
  assert.equal((svg.match(/<circle[^>]*fill="#FFFFFF"/g) || []).length, 2, 'two white circuit nodes expected');
  assert.ok(!/#2563eb|#334155/i.test(svg), 'the previous blue/slate palette must be gone');
  // Minimal: no embedded raster, filter, font, script, external reference or <defs>.
  for (const forbidden of ['<image', '<filter', '<font', '<script', 'href=', 'url(', '@import', '<use', '<defs', 'data:']) {
    assert.equal(svg.includes(forbidden), false, `favicon must not contain ${forbidden}`);
  }
  // The only absolute URL is the SVG namespace.
  assert.equal((svg.match(/https?:\/\//g) || []).length, 1, 'only the SVG namespace URL is allowed');
  assert.ok(svg.length < 700, `favicon should stay minimal (was ${svg.length} bytes)`);
});

test('the favicon data URI is valid, decodes cleanly and parses as SVG', () => {
  const href = /href="([^"]+)"/.exec(cflabFavicon())[1];
  assert.ok(href.startsWith('data:image/svg+xml,'), 'favicon must be an inline SVG data URI');
  // Encoded form must be safe inside an HTML attribute and carry no raw markup.
  assert.equal(href.includes('<'), false, 'raw < must be encoded');
  assert.equal(href.includes('>'), false, 'raw > must be encoded');
  assert.equal(href.includes('"'), false, 'raw double quote must be encoded');
  assert.equal(href.includes(' '), false, 'spaces must be encoded');
  assert.ok(href.includes('%23F38020'), 'the orange hex must be URI-encoded');

  const decoded = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  assert.equal(decoded, cflabFaviconSvg());

  const window = new Window();
  window.document.body.innerHTML = decoded;
  const element = window.document.querySelector('svg');
  assert.ok(element, 'decoded favicon must parse as an <svg> element');
  assert.equal(element.getAttribute('viewBox'), '0 0 32 32');
  assert.equal(window.document.querySelectorAll('path[fill="#F38020"]').length, 1, 'one orange flask silhouette');
  assert.equal(window.document.querySelectorAll('circle[fill="#FFFFFF"]').length, 2, 'two white circuit nodes');
  window.close();
});


test('the authenticated console embeds exactly one inline favicon in its head', () => {
  const html = consolePage();
  assert.equal((html.match(/rel="icon"/g) || []).length, 1, 'exactly one icon declaration expected');
  const link = /<link rel="icon"[^>]*>/.exec(html)[0];
  assert.equal(link, cflabFavicon(), 'console favicon must match the CFLab artwork exactly');
  assert.ok(html.indexOf(link) < html.indexOf('</head>'), 'favicon must be declared in the head');
  assert.ok(html.indexOf(link) > html.indexOf('<head>'));
  assert.ok(!html.includes('/favicon.svg') && !html.includes('/favicon.ico'), 'no favicon asset references allowed');
});

test('the CFLab administration and account shells reuse the same favicon', () => {
  for (const shell of ['plainShell', 'appShell']) {
    const source = new RegExp(`function ${shell}\\([\\s\\S]*?\\n}`).exec(UI_SOURCE);
    assert.ok(source, `${shell} not found`);
    assert.ok(source[0].includes('+ FAVICON +'), `${shell} must inject the shared FAVICON into <head>`);
  }
  // One declaration, built once, so login, recovery, account and user admin agree.
  assert.equal((UI_SOURCE.match(/const FAVICON =/g) || []).length, 1);
});

test('analytics dashboard reuses the exact CFLab inline flask favicon', () => {
  const expected = cflabFavicon();
  assert.ok(INDEX_HTML.includes(expected), 'analytics-ui/index.html must contain the exact CFLab favicon declaration');
  assert.equal((INDEX_HTML.match(/rel="icon"/g) || []).length, 1, 'exactly one icon declaration expected');
  assert.ok(!INDEX_HTML.includes('/favicon.svg') && !INDEX_HTML.includes('/favicon.ico'), 'no favicon asset references allowed');
});

test('no favicon asset is shipped in the analytics-ui directory', () => {
  const files = readdirSync(new URL('../../analytics-ui/', import.meta.url));
  assert.equal(files.some(name => /^favicon\./i.test(name)), false);
});
