import { Hono } from 'hono';
import type { AnalyticsBindings, AnalyticsEnv } from './env';
import { ApiError } from '../http';
import { collector } from './collector';
import { sites } from './api';
import { runMaintenance } from './maintenance';

export const app = new Hono<AnalyticsEnv>({ strict: false });

// Collector CORS: the browser origin is validated against the resolved Site's
// active domains inside the handler. Preflight has no body, so it echoes the
// origin without deciding; CORS is not the authorization boundary.
app.use('*', async (c, next) => {
  const path = c.req.path;
  const collectPath = path === '/collect' || path.startsWith('/api/analytics/collect');
  const origin = c.req.header('Origin');
  if (collectPath && origin && c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '300',
      Vary: 'Origin',
    });
  }
  const start = Date.now();
  await next();
  if (collectPath && origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
  }
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  console.log(JSON.stringify({ event: 'request', method: c.req.method, status: c.res.status, duration_ms: Date.now() - start }));
});

app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  console.error(JSON.stringify({ event: 'internal_error' }));
  return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
});
app.notFound(c => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

app.get('/api/health', c => c.json({ status: 'ok', service: 'cflab-analytics' }));
app.route('/', collector);
app.route('/api/sites', sites);

export default {
  fetch: (request: Request, env: AnalyticsBindings, ctx: ExecutionContext): Response | Promise<Response> =>
    app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: AnalyticsBindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(runMaintenance(env.ANALYTICS).catch(() => {
      console.error(JSON.stringify({ event: 'maintenance_failed' }));
    }));
  },
};
