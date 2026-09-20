import { Hono, type MiddlewareHandler } from 'hono';
import type { AppRow, ContextEnv } from './types';
import { ApiError, slug } from './http';
import { authenticate } from './auth/tokens';
import { admin, appOutput } from './routes/admin';
import { auth, authCors } from './routes/auth';
import { records } from './routes/records';
import { files } from './routes/files';
import { proxy } from './routes/proxy';
import { publicSafari } from './routes/public-safari';
import { accountPage, forgotPage, loginPage, resetPage, usersPage } from './ui';

const methods = ['GET', 'POST', 'PATCH', 'DELETE'];
const allowedHeaders = ['authorization', 'content-type', 'x-filename', 'x-file-id', 'x-record-id', 'x-resource'];
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
}

export function createApp(adminAuth: MiddlewareHandler<ContextEnv>) {
  const app = new Hono<ContextEnv>({ strict: false });
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    // Public media may set its own cache policy; everything else is no-store.
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.res.headers.has('Vary')) c.header('Vary', 'Origin');
    // Do not log URLs, query strings, authorization, payloads, or upstream errors.
    console.log(JSON.stringify({ event: 'request', method: c.req.method, status: c.res.status, duration_ms: Date.now() - start }));
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.status === 401) c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(JSON.stringify({ event: 'internal_error' }));
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));
  app.get('/api/health', c => c.json({ status: 'ok', service: 'cflab' }));
  app.use('/api/auth/*', authCors);
  app.route('/api/auth', auth);
  app.route('/api/public/wildlife-safari', publicSafari);
  app.use('/api/admin/*', adminAuth);
  app.route('/api/admin', admin);
  app.get('/admin', c => c.redirect('/admin/users'));
  app.get('/admin/login', () => html(loginPage()));
  app.get('/admin/users', () => html(usersPage()));
  app.get('/account', () => html(accountPage()));
  app.get('/forgot-password', () => html(forgotPage()));
  app.get('/reset-password', () => html(resetPage()));
  app.use('/api/apps/:app/*', async (c, next) => {
    const row = await c.env.DB.prepare('SELECT * FROM apps WHERE id = ? AND active = 1').bind(slug(c.req.param('app'))).first<AppRow>();
    if (!row) throw new ApiError(404, 'app_not_found', 'App not found');
    c.set('app', row);
    const origin = c.req.header('Origin');
    if (origin) {
      const allowed = await c.env.DB.prepare('SELECT 1 FROM app_origins WHERE app_id = ? AND origin = ?').bind(row.id, origin).first();
      if (!allowed) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Expose-Headers', 'Content-Disposition, ETag');
    }
    if (c.req.method === 'OPTIONS') {
      const method = c.req.header('Access-Control-Request-Method');
      const headers = (c.req.header('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!origin || !method || !methods.includes(method) || headers.some(h => !allowedHeaders.includes(h))) {
        throw new ApiError(403, 'preflight_denied', 'Preflight not allowed');
      }
      c.header('Access-Control-Allow-Methods', methods.join(', '));
      c.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      c.header('Access-Control-Max-Age', '300');
      c.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      return c.body(null, 204);
    }
    await next();
    // Raw streaming Responses do not inherit headers set before the handler.
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Expose-Headers', 'Content-Disposition, ETag');
    }
  });
  app.use('/api/apps/:app/*', authenticate);
  app.get('/api/apps/:app', c => c.json(appOutput(c.get('app'))));
  app.route('/api/apps/:app/resources/:resource/records', records);
  app.route('/api/apps/:app/files', files);
  app.route('/api/apps/:app/proxy', proxy);
  return app;
}
