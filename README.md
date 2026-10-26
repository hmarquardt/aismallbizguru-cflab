# CFLab

A small Cloudflare-native backend for static applications that need shared records, files, and approved API proxies. One TypeScript Worker, three dedicated D1 databases (`cflab`, `cflab-analytics`, `cflab-bitcoin-signals`), and one private R2 bucket. No server, containers, ORM, or background service. Machine API tokens remain app-scoped service credentials; a separate human authentication system adds email/password users, sessions, and project memberships. See [AUTH.md](docs/AUTH.md). Analytics is a second, independently deployable Worker in the same repository that shares the `cflab-analytics` D1 database and validates CFLab sessions through a narrow service binding; see [ANALYTICS.md](docs/ANALYTICS.md).

This is a working local MVP, **not a drop-in LabBox replacement**. The source/client evidence and classified differences are in [COMPATIBILITY.md](docs/COMPATIBILITY.md); the parallel migration plan is in [MIGRATION.md](docs/MIGRATION.md).

The independent deployment target is **https://cflab.aismallbizguru.com**, a lasting production-equivalent environment with its own three D1 databases (`cflab`, `cflab-analytics`, `cflab-bitcoin-signals`) and private `cflab-files` R2 bucket. **https://lab.aismallbizguru.com continues serving the existing LabBox unchanged.** Consumers can migrate and validate against CFLab before any future hostname cutover.

`/` is an authenticated operations console for that deployment: live service
overview and warnings, a declarative service registry, a read-only D1 workbench with
CSV export and per-administrator saved statements, scheduled-job history, and a
system view (revision, binding presence, database reachability, backup
attestation). It runs in the existing Worker with the existing administrator
session. See [CONSOLE.md](docs/CONSOLE.md).

## Bitcoin Signals

Bitcoin Signals is a private research instrument inside this repository, served at
`/bitcoin-signals` by the same Worker. It answers one question with retained,
source-attributed measurements: is bitcoin becoming money that businesses,
governments, and individuals hold and use, or another rail for moving fiat?

Its data lives in a third D1 database, `cflab-bitcoin-signals` (binding
`BTC_SIGNALS`, migrations in `migrations-bitcoin-signals/`). Project identity,
users, and memberships stay in the primary `cflab` database, and the Worker
resolves the storage backend through an explicit server-side allowlist. Scheduled
collection runs from this Worker's cron triggers, so the instrument keeps updating
without a browser. It is a research tool: no trading, no brokerage keys, no
custody, and no composite investment score.

Bitcoin Signals is deployed through the existing gated pipeline with access pinned
to the existing operator account. Production treasury collection is authenticated
with the CoinGecko Demo API key held as a Worker Secret, and end-to-end acceptance
is complete; see the [acceptance record](docs/BITCOIN-SIGNALS-ACCEPTANCE.md).
Enabled collectors cover OKX funding/history and spot/index data, Kraken
spot/funding/futures-basis data, Coinbase spot, mempool.space statistics, and daily
CoinGecko treasury reports for the operator's private personal research. Deribit
remains disabled for US residency. The [data-rights review](docs/BITCOIN-SIGNALS-DATA-RIGHTS.md)
records the personal-use interpretations and authorized CoinGecko retention exception. See the
[independent audit](docs/BITCOIN-SIGNALS-AUDIT.md) for validation and release blockers.

```sh
npm run db:migrate:signals   # local schema only
npm run dev                  # http://127.0.0.1:8787/bitcoin-signals
```

Provisioning, sources, funding conventions, alerts, and operations are documented
in [BITCOIN-SIGNALS.md](docs/BITCOIN-SIGNALS.md).

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

Bitcoin Signals uses its own local schema and runs inside the primary Worker:

```sh
npm run db:migrate:signals
npm run dev            # http://127.0.0.1:8787/bitcoin-signals
```

Wrangler listens on `http://127.0.0.1:8787`. D1 and R2 are simulated locally and persist under `.wrangler/state`. Both `dev` and `db:migrate` explicitly use `wrangler.local.jsonc`, so setting the real deployment database ID does not switch local development storage. `.dev.vars` is ignored by Git; never put real secrets in the example file. The local admin entrypoint requires the secret, a loopback host, and no browser Origin header; human admin sessions also work there. Minimal account pages are served at `/admin/login`, `/admin/users`, `/account`, `/forgot-password`, and `/reset-password`. Auth mail uses Cloudflare Email Service (Email Sending); locally the `send_email` binding is simulated so no real email is sent — see [AUTH.md](docs/AUTH.md#email).

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

Nothing in local setup, `npm run check`, local migrations, or `build` deploys remotely. The local D1 IDs remain placeholders; production IDs are recorded in their Wrangler configs, including the authorized but unmigrated Signals database; workers.dev/preview URLs remain disabled, the proxy hostname allowlist is empty, and production administration requires a human admin session. Authentication mail requires the `send_email` binding and an onboarded Email Sending domain (CFLab uses `mail.aismallbizguru.com`); without them, setup requests report a failure instead of a successful invitation. Do not deploy `wrangler.local.jsonc` or `src/local.ts`.

GET-only remote comparison is explicit: `npm run test:compat` requires `LABBOX_BASE_URL` and `CFLAB_BASE_URL`. It is excluded from normal tests and CI. See [remote checks](docs/DEPLOYMENT.md#read-only-parallel-checks) for record/collection fixtures, read tokens, optional anonymous/CORS checks, and the separate legacy-health safety gate. Normal checks test the probe harness offline without contacting either deployment.

## Releases

Production is released by **GitHub Actions**, not from a developer machine:
push to `main` → validate → deploy both Workers → verify production. Releases are
gated by the repository variable `CLOUDFLARE_DEPLOY_ENABLED`, and every release is
tied to a commit that passed CI. `npm run deploy` deliberately refuses and prints
the policy; direct Wrangler deployment is reserved for documented emergencies.

Read **[AGENTS.md](AGENTS.md)** before changing anything — it is the entry point for
coding agents and states the release, migration, and data-handling rules. The
runbook (release order, migration approvals, verification, rollback, D1 recovery,
emergency deployment) is [docs/CI-CD.md](docs/CI-CD.md), and backup, retention, and
recovery are documented in [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md).

## Project map

`src/app.ts` composes routing, errors, logging, CORS, and app authentication. `src/routes/` holds straightforward SQL-backed handlers. `src/auth/` holds machine tokens, human sessions, password hashing, mail, rate-limit helpers, and the internal `HumanAuthService` entrypoint. `src/analytics/` is the separate Analytics Worker (collector, site API, reporting, maintenance, sanitization). `src/ui.ts` holds the small server-rendered account pages. `src/proxy/` contains URL/DNS policy. `analytics-ui/` is the analytics dashboard and tracking script. `migrations/`, `migrations-analytics/`, and `migrations-bitcoin-signals/` own the three D1 schemas, and `src/bitcoin-signals/` is the Bitcoin Signals research instrument. `test/` exercises behavior. [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the boundaries and intentional limitations; [AUTH.md](docs/AUTH.md) documents the human identity model and bootstrap; [ANALYTICS.md](docs/ANALYTICS.md) documents the analytics service.

Current implementation references: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/), [local bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), and [Workers DNS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/). The installed plugin exports `readD1Migrations` from its package root; the pinned package declarations are authoritative where documentation examples differ.
