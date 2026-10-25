import { createApp } from './app';
import { requireHumanAdmin } from './auth/human';
import type { Bindings } from './types';
import { jobForCron, runCollectionJob } from './bitcoin-signals/collector';

// Production administration is a normal human session with is_admin; there is no
// development bypass and no Cloudflare Access dependency in this entrypoint.
// HumanAuthService is a named internal service-binding entrypoint for the
// Analytics Worker; it does not expose an HTTP route.
export { HumanAuthService } from './auth/service';

const app = createApp(requireHumanAdmin);

// Scheduled collection runs in this Worker, so Bitcoin Signals keeps updating
// without an open browser. `wrangler.jsonc` declares two crons: an hourly market
// and network collection and a daily slower-adoption collection.
export default {
  fetch: (request: Request, env: Bindings = {} as Bindings): Response | Promise<Response> => app.fetch(request, env),
  scheduled: (event: ScheduledController, env: Bindings, ctx: ExecutionContext): void => {
    const job = jobForCron(event.cron);
    ctx.waitUntil(runCollectionJob(env, job, { trigger: 'cron' })
      .then(result => {
        console.log(JSON.stringify({
          event: 'bitcoin_signals_collection', job, status: result.status,
          reason: result.reason ?? null, added: result.observations_added, sources: result.sources.length,
        }));
      })
      .catch(() => {
        console.error(JSON.stringify({ event: 'bitcoin_signals_collection_failed', job }));
      }));
  },
} satisfies ExportedHandler<Bindings>;
