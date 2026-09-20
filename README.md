# CFLab

A small Cloudflare-native backend for static applications that need shared records, files, and approved API proxies. One TypeScript Worker, one D1 database, one private R2 bucket. No server, containers, ORM, or background service. Machine API tokens remain app-scoped service credentials; a separate human authentication system adds email/password users, sessions, and project memberships. See [AUTH.md](docs/AUTH.md). Analytics is a second, independently deployable Worker in the same repository that shares the `cflab-analytics` D1 database and validates CFLab sessions through a narrow service binding; see [ANALYTICS.md](docs/ANALYTICS.md).

This is a working local MVP, **not a drop-in LabBox replacement**. The source/client evidence and classified differences are in [COMPATIBILITY.md](docs/COMPATIBILITY.md); the parallel migration plan is in [MIGRATION.md](docs/MIGRATION.md).

The independent deployment target is **https://cflab.aismallbizguru.com**, a lasting production-equivalent environment with its own `cflab` D1 database and private `cflab-files` R2 bucket. **https://lab.aismallbizguru.com continues serving the existing LabBox unchanged.** Consumers can migrate and validate against CFLab before any future hostname cutover.

## Local development

Prerequisites: Node.js 22.12+ (Node 24 LTS recommended), npm, and a platform supported by Wrangler/workerd. Local development and tests do not require a Cloudflare account. Proxy calls require internet access.

```sh
npm ci
cp .dev.vars.example .dev.vars
openssl rand -hex 32
# Put the generated value in .dev.vars as DEV_ADMIN_TOKEN.
npm run db:migrate
npm run dev
```

For the Analytics Worker (a second terminal, CFLab running for session validation):

```sh
npm run db:migrate:analytics
npm run dev:analytics
```

Wrangler listens on `http://127.0.0.1:8787`. D1 and R2 are simulated locally and persist under `.wrangler/state`. Both `dev` and `db:migrate` explicitly use `wrangler.local.jsonc`, so setting the real deployment database ID does not switch local development storage. `.dev.vars` is ignored by Git; never put real secrets in the example file. The local admin entrypoint requires the secret, a loopback host, and no browser Origin header; human admin sessions also work there. Minimal account pages are served at `/admin/login`, `/admin/users`, `/account`, `/forgot-password`, and `/reset-password`. Local auth mail is simulated by the `send_email` binding; no real email is sent.

```sh
curl http://127.0.0.1:8787/api/health
# Set ADMIN_TOKEN in your shell to the local value, without committing it.
curl http://127.0.0.1:8787/api/admin/apps \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"demo","name":"Demo","origins":["http://localhost:5173"]}'
curl http://127.0.0.1:8787/api/admin/apps/demo/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo-client","scopes":["records:read","records:write","files:read","files:write","proxy:use"]}'
```

Save the returned app token; this is its only plaintext appearance. See [API.md](docs/API.md) for record, file, proxy, authentication, and administration examples. App bearer tokens are capabilities: anyone who obtains one has its app-wide scopes. Do not embed privileged tokens in a publicly distributed frontend or commit them. Human users log in at `/admin/login`; human sessions are also bearer credentials and are revocable. CORS does not make a browser credential secret.

## Verification

```sh
npm run types       # regenerate runtime/binding declarations after config changes
npm run typecheck   # strict checks for application, tests, and test config
npm test           # Workers-compatible Vitest, actual ephemeral local D1/R2
npm run test:ui    # Analytics dashboard logic/DOM tests (Node + happy-dom)
npm run verify:chart  # fails if the vendored Chart.js copy drifts from node_modules
npm run build      # bundle only: wrangler deploy --dry-run
npm run build:analytics  # Analytics Worker bundle only
```

Tests apply the real SQL migration to separate ephemeral storage. Only upstream DNS/HTTP are mocked; D1 and R2 behavior is real local binding behavior. Tests do not touch development or production data. The suite includes cross-app writes/deletes, token revocation, preflights, body limits, proxy redirects/timeouts, and R2/D1 compensation. There is no separate linter configured; strict TypeScript catches unused code. Dependencies are exact-pinned with `package-lock.json`.

## Independent deployment

`wrangler.jsonc` targets only the custom domain `cflab.aismallbizguru.com`. Follow [DEPLOYMENT.md](docs/DEPLOYMENT.md) for exact resource creation, account configuration, migrations, publishing, and verification commands. No additional staging config is needed for this parallel production-equivalent environment.

Nothing in local setup, `npm run check`, local migrations, or `build` deploys remotely. The D1 ID remains a placeholder; workers.dev/preview URLs remain disabled, the proxy hostname allowlist is empty, and production administration requires a human admin session. `AUTH_FROM_EMAIL` stays empty until a sending domain is deliberately onboarded, so authentication mail is not operational yet. Do not deploy `wrangler.local.jsonc` or `src/local.ts`.

GET-only remote comparison is explicit: `npm run test:compat` requires `LABBOX_BASE_URL` and `CFLAB_BASE_URL`. It is excluded from normal tests and CI. See [remote checks](docs/DEPLOYMENT.md#read-only-parallel-checks) for record/collection fixtures, read tokens, optional anonymous/CORS checks, and the separate legacy-health safety gate. Normal checks test the probe harness offline without contacting either deployment.

## Project map

`src/app.ts` composes routing, errors, logging, CORS, and app authentication. `src/routes/` holds straightforward SQL-backed handlers. `src/auth/` holds machine tokens, human sessions, password hashing, mail, rate-limit helpers, and the internal `HumanAuthService` entrypoint. `src/analytics/` is the separate Analytics Worker (collector, site API, reporting, maintenance, sanitization). `src/ui.ts` holds the small server-rendered account pages. `src/proxy/` contains URL/DNS policy. `analytics-ui/` is the analytics dashboard and tracking script. `migrations/` and `migrations-analytics/` own the two D1 schemas. `test/` exercises behavior. [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the boundaries and intentional limitations; [AUTH.md](docs/AUTH.md) documents the human identity model and bootstrap; [ANALYTICS.md](docs/ANALYTICS.md) documents the analytics service.

Current implementation references: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/), [local bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), and [Workers DNS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/). The installed plugin exports `readD1Migrations` from its package root; the pinned package declarations are authoritative where documentation examples differ.
