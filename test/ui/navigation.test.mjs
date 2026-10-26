import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { CLIENT_NAVIGATION_JS, loginDestination, safeReturnPath } from '../../src/navigation.js';
import { consolePage } from '../../src/console/page.js';
import { signalsPage } from '../../src/bitcoin-signals/dashboard.js';

const UI_SOURCE = readFileSync(new URL('../../src/ui.ts', import.meta.url), 'utf8');
const ADMIN = { email: 'admin@example.com', is_admin: true };
const MEMBER = { email: 'member@example.com', is_admin: false };

test('after login, administrators land on the Control Center and everyone else on the account page', () => {
  assert.equal(loginDestination(ADMIN, ''), '/');
  assert.equal(loginDestination(MEMBER, ''), '/account');
  assert.equal(loginDestination(null, ''), '/account');
  assert.equal(loginDestination(undefined, '?foo=bar'), '/account');
  assert.equal(loginDestination({ is_admin: false }, '?next=//evil.test'), '/account');
});

test('an explicitly requested, validated return URL wins for either role', () => {
  assert.equal(loginDestination(ADMIN, '?next=%2Fbitcoin-signals'), '/bitcoin-signals');
  assert.equal(loginDestination(MEMBER, '?next=%2Fbitcoin-signals'), '/bitcoin-signals');
  assert.equal(loginDestination(ADMIN, '?next=%2Fbitcoin-signals%3Ftab%3Dradar'), '/bitcoin-signals?tab=radar');
  assert.equal(loginDestination(MEMBER, '?next=%2Faccount%23sessions'), '/account#sessions');
  assert.equal(loginDestination(MEMBER, '?next=%2F'), '/');
  assert.equal(loginDestination(ADMIN, '?next=%2Fadmin%2Fusers'), '/admin/users');
});

test('unsafe or unusable return URLs are discarded rather than repaired', () => {
  const rejected = [
    '//evil.test', '///evil.test', 'https://evil.test', 'http://cflab.aismallbizguru.com/account',
    '/\\evil.test', '\\\\evil.test', '/path with space', '/tab\tpath', '/line%0d%0abreak', '/nul%00byte',
    '/admin/login', '/admin/login?next=/x', '/forgot-password', '/reset-password', '/api/auth/me',
    'javascript:alert(1)', 'account', '', '   ', null, undefined, 42, {}, 'x'.repeat(513),
  ];
  for (const value of rejected) {
    assert.equal(safeReturnPath(value), null, `expected ${JSON.stringify(value)} to be refused`);
  }
  for (const value of rejected) {
    const search = `?next=${encodeURIComponent(String(value))}`;
    assert.equal(loginDestination(MEMBER, search), '/account', `expected ${JSON.stringify(value)} to fall back`);
    assert.equal(loginDestination(ADMIN, search), '/', `expected ${JSON.stringify(value)} to fall back for admin`);
  }
});

test('the injected sign-in script behaves exactly like the tested module', () => {
  const window = new Window({ url: 'https://cflab.aismallbizguru.com/admin/login' });
  window.eval(CLIENT_NAVIGATION_JS);
  assert.equal(typeof window.loginDestination, 'function', 'injected loginDestination must be defined');
  assert.equal(typeof window.safeReturnPath, 'function', 'injected safeReturnPath must be defined');
  const cases = [
    [ADMIN, ''], [MEMBER, ''], [null, ''], [ADMIN, '?next=%2Fbitcoin-signals'], [MEMBER, '?next=%2Fbitcoin-signals'],
    [ADMIN, '?next=//evil.test'], [MEMBER, '?next=https://evil.test'], [ADMIN, '?next=%2Fadmin%2Flogin'],
    [MEMBER, '?next=%2Faccount%3Fx%3D1'], [ADMIN, '?next=%2Fapi%2Fauth%2Fme'],
  ];
  for (const [user, search] of cases) {
    assert.equal(window.loginDestination(user, search), loginDestination(user, search), `mismatch for ${JSON.stringify([user, search])}`);
  }
  for (const value of ['/ok', '//evil.test', '/admin/login', null, 42]) {
    assert.equal(window.safeReturnPath(value), safeReturnPath(value), `safeReturnPath mismatch for ${JSON.stringify(value)}`);
  }
  window.close();
});

test('the sign-in page uses the shared policy instead of a hard-coded destination', () => {
  assert.match(UI_SOURCE, /import \{ CLIENT_NAVIGATION_JS \} from '\.\/navigation';/);
  assert.ok(UI_SOURCE.includes('CLIENT_NAVIGATION_JS + `'), 'login page must inject the shared client policy');
  assert.ok(UI_SOURCE.includes('location.href=loginDestination(data.user,location.search)'), 'login redirect must use the shared policy');
  assert.equal(UI_SOURCE.includes("is_admin?'/admin/users'"), false, 'the old hard-coded admin destination must be gone');
  // Pages that bounce an unauthenticated visitor keep the requested path.
  assert.equal((UI_SOURCE.match(/\/admin\/login\?next='\+encodeURIComponent\(location\.pathname\)/g) || []).length, 2);
});

test('the CFLab brand links to the Control Center on every shared header', () => {
  // Admin and account shell (login/forgot/reset use the plain shell without a header).
  const shell = /function appShell\([\s\S]*?\n}/.exec(UI_SOURCE)[0];
  assert.ok(shell.includes('<a class="brand" href="/">CFLab</a>'), 'appShell brand must point at /');
  assert.equal(shell.includes('class="brand" href="/account"'), false);
  assert.ok(shell.includes('<a href="/account">Account</a>'), '/account must stay reachable from the header');
  assert.ok(shell.includes('<a id="nav-admin" href="/admin/users"'), 'the admin users link is unchanged');

  for (const [label, html] of [['console', consolePage()], ['signals', signalsPage()]]) {
    const brand = /<a class="brand"[^>]*>/.exec(html);
    assert.ok(brand, `${label} must render a brand link`);
    assert.ok(brand[0].includes('href="/"'), `${label} brand must point at /`);
    assert.equal(html.includes('class="brand" href="/account"'), false, `${label} brand must not point at /account`);
  }
  assert.ok(consolePage().includes('href="/account"'), 'the console keeps its Account link');
});
