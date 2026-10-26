// Post-login navigation policy, shared by the sign-in page and the tests.
//
// The login page is a plain HTML document whose script runs in the browser, so
// the two small functions below are also emitted as standalone source
// (CLIENT_NAVIGATION_JS) and injected into that page. They are written as plain
// ES5 functions with no outer references so their own source is valid JavaScript;
// test/ui/navigation.test.mjs evaluates the injected copy and proves it behaves
// exactly like the imported one.
//
// Rules:
//   * an explicitly requested return URL wins when it is a same-origin path;
//   * otherwise administrators land on the Control Center ("/") and everyone
//     else on the account page ("/account");
//   * a return URL that could leave the origin, re-enter the sign-in flow, hit an
//     API route, or carry control characters is discarded rather than repaired.

export function safeReturnPath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 512) return null;
  if (value.charAt(0) !== '/' || value.charAt(1) === '/' || value.charAt(1) === '\\') return null;
  // Whitespace, control characters and backslashes: browsers normalise some of
  // these into a different URL than the one that was validated.
  if (/[\u0000-\u0020\u007f]/.test(value) || value.indexOf('\\') !== -1) return null;
  // Percent-encoded control characters are refused for the same reason.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  var parsed;
  try {
    parsed = new URL(value, 'https://cflab.invalid');
  } catch (error) {
    return null;
  }
  if (parsed.origin !== 'https://cflab.invalid') return null;
  if (parsed.pathname.indexOf('/api/') === 0) return null;
  if (parsed.pathname === '/admin/login' || parsed.pathname === '/forgot-password' || parsed.pathname === '/reset-password') return null;
  return parsed.pathname + parsed.search + parsed.hash;
}

export function loginDestination(user, search) {
  var params = new URLSearchParams(typeof search === 'string' ? search : '');
  var next = safeReturnPath(params.get('next'));
  if (next) return next;
  return user && user.is_admin ? '/' : '/account';
}

// Emitted into the sign-in page. `safeReturnPath` must stay ahead of its caller.
export const CLIENT_NAVIGATION_JS = `var safeReturnPath=${safeReturnPath.toString()};var loginDestination=${loginDestination.toString()};`;
