import { createApp } from './app';
import { hashToken } from './auth/crypto';
import { requireHumanAdmin } from './auth/human';

// Used exclusively by wrangler.local.jsonc. Never deploy this entrypoint.
// Loopback + DEV_ADMIN_TOKEN remains a local convenience; otherwise human admin sessions apply.
export default createApp(async (c, next) => {
  const host = new URL(c.req.url).hostname;
  const secret = (c.env as typeof c.env & { DEV_ADMIN_TOKEN?: string }).DEV_ADMIN_TOKEN;
  const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host) && !c.req.header('Origin')
    && secret && secret.length >= 32 && supplied && supplied.length <= 256
    && await hashToken(supplied) === await hashToken(secret)) {
    await next();
    return;
  }
  await requireHumanAdmin(c, next);
});
