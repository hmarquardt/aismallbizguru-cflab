import { createApp } from './app';
import { hashToken } from './auth/crypto';
import { requireHumanAdmin } from './auth/human';
import type { Bindings } from './types';
import { jobForCron, runCollectionJob } from './bitcoin-signals/collector';

// Used exclusively by wrangler.local.jsonc. Never deploy this entrypoint.
// Loopback + DEV_ADMIN_TOKEN remains a local convenience; otherwise human admin sessions apply.
// HumanAuthService mirrors the production entrypoint so `npm run dev:analytics`
// can validate sessions through the local service binding during development.
export { HumanAuthService } from './auth/service';

const app = createApp(async (c, next) => {
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

// The local entrypoint mirrors the scheduled handler so collection can be
// exercised locally with `wrangler dev --test-scheduled` and
// `curl "http://127.0.0.1:8787/__scheduled?cron=7+*+*+*+*"`. The local config has
// no production route, so this can never run against production.
export default {
  fetch: (request: Request, env: Bindings = {} as Bindings): Response | Promise<Response> => app.fetch(request, env),
  scheduled: (event: ScheduledController, env: Bindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(runCollectionJob(env, jobForCron(event.cron), { trigger: 'cron' }).catch(() => undefined));
  },
} satisfies ExportedHandler<Bindings>;
