import { createApp } from './app';
import { ApiError } from './http';
import { hashToken } from './auth/tokens';

// Used exclusively by wrangler.local.jsonc. Never deploy this entrypoint.
export default createApp(async (c, next) => {
  const host = new URL(c.req.url).hostname;
  const secret = (c.env as typeof c.env & { DEV_ADMIN_TOKEN?: string }).DEV_ADMIN_TOKEN;
  const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || c.req.header('Origin')
    || !secret || secret.length < 32 || !supplied || supplied.length > 256
    || await hashToken(supplied) !== await hashToken(secret)) {
    throw new ApiError(403, 'admin_denied', 'Local admin authentication required');
  }
  await next();
});
