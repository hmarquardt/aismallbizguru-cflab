# CFLab

A small Cloudflare-native backend for static applications that need shared records, files, and approved API proxies. One TypeScript Worker, one D1 database, one private R2 bucket. No server, containers, ORM, or background service.

This is a working local MVP, **not a drop-in LabBox replacement**. The previous repository was inspected; concrete differences and the parallel migration plan are in [MIGRATION.md](docs/MIGRATION.md).

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

Wrangler listens on `http://127.0.0.1:8787`. D1 and R2 are simulated locally, persist under `.wrangler/state`, and are shared by the two config files because the binding identifiers match. `.dev.vars` is ignored by Git; never put real secrets in the example file. The local admin entrypoint requires the secret, a loopback host, and no browser Origin header. Use a terminal client; there is no admin UI.

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

Save the returned app token; this is its only plaintext appearance. See [API.md](docs/API.md) for record, file, proxy, and administration examples. App bearer tokens are capabilities: anyone who obtains one has its app-wide scopes. Do not embed privileged tokens in a publicly distributed frontend or commit them. This MVP does not provide user accounts or per-user record ownership. CORS does not make a browser token secret.

## Verification

```sh
npm run types       # regenerate runtime/binding declarations after config changes
npm run typecheck   # strict checks for application, tests, and test config
npm test           # Workers-compatible Vitest, actual ephemeral local D1/R2
npm run build      # bundle only: wrangler deploy --dry-run
```

Tests apply the real SQL migration to separate ephemeral storage. Only upstream DNS/HTTP are mocked; D1 and R2 behavior is real local binding behavior. Tests do not touch development or production data. The suite includes cross-app writes/deletes, token revocation, preflights, body limits, proxy redirects/timeouts, and R2/D1 compensation. There is no separate linter configured; strict TypeScript catches unused code. Dependencies are exact-pinned with `package-lock.json`.

## Deliberate deployment

Nothing in setup, tests, migrations above, or `build` deploys remotely. The production config has a placeholder database ID, no routes, disabled workers.dev/preview URLs, an empty proxy hostname allowlist, and closed admin routes. Do not deploy `wrangler.local.jsonc` or `src/local.ts`.

When ready for a **separate staging deployment**:

1. Authenticate Wrangler (`npx wrangler login`). Create a new D1 database and private R2 bucket using `npx wrangler d1 create cflab-staging` and `npx wrangler r2 bucket create cflab-staging-files`. Do not reuse LabBox resources.
2. Make a staging config from `wrangler.jsonc`: set a distinct Worker name, database name/ID, and bucket name. Retain `src/index.ts`. Explicitly configure a staging route/domain or enable workers.dev only for staging. Keep the R2 bucket private; do not enable public bucket access.
3. Decide how staging will be administered. Production administration is intentionally disabled. Implement verified Cloudflare Access JWT authorization at the seam in `src/index.ts` before enabling admin routes. Validate signature, issuer, audience, expiry, and intended admin identity/policy; do not trust a header merely because it is present. Protect every exposure path, including workers.dev if enabled. No custom passwords are needed.
4. Set `PROXY_ALLOWED_HOSTS` to exact audited provider hostnames, if proxies are needed. Set `PROXY_SECRETS` using `npx wrangler secret put PROXY_SECRETS --config wrangler.staging.jsonc` (JSON mapping secret names to values). Store only secret references in D1. App config is client-readable and must contain no secrets.
5. Review the target config, then deliberately run `npx wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc`, `npx wrangler deploy --dry-run --config wrangler.staging.jsonc`, and finally `npx wrangler deploy --config wrangler.staging.jsonc --no-x-provision`.
6. Provision staging apps/tokens through the verified admin boundary, smoke-test records/files/proxies, then follow the parallel-run migration checklist. Keep the old LabBox live until acceptance and rollback are established.

No production deployment script or DNS change is included. Before public rollout, choose abuse/rate limits appropriate to the clients, rehearse backup/restore for D1 and R2, and review the proxy trust boundary. No scheduled backups or rate limiter is claimed in this pass.

## Project map

`src/app.ts` composes routing, errors, logging, CORS, and app authentication. `src/routes/` holds straightforward SQL-backed handlers. `src/auth/` holds token handling. `src/proxy/` contains URL/DNS policy. `migrations/` owns the D1 schema. `test/` exercises behavior. [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the boundaries and intentional limitations.

Current implementation references: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/), [local bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), and [Workers DNS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/). The installed plugin exports `readD1Migrations` from its package root; the pinned package declarations are authoritative where documentation examples differ.
