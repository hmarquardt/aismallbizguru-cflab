// Retry the complete strict verification while Cloudflare propagates a release.
//
// A partial result is never accepted: every attempt runs every check again, so a
// passing run always means the whole contract held at one moment. This exists
// because immediately after an upload Cloudflare can briefly serve the previous
// routing configuration from some regions.
export async function verifyUntilReady(check, {
  timeoutMs = 120000, intervalMs = 5000, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.warn,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    try { return await check(); }
    catch (error) {
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      log(`Production not ready (attempt ${++attempt}): ${error.message}`);
      await wait(Math.min(intervalMs, remaining));
    }
  }
}
