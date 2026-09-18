# Independent CFLab deployment

Target: **https://cflab.aismallbizguru.com**. This is CFLab's lasting production-equivalent environment. **https://lab.aismallbizguru.com stays on the existing LabBox**; no step here changes its DNS, routes, service, data, or infrastructure.

| Component | CFLab target |
| --- | --- |
| Worker | `cflab`, entrypoint `src/index.ts` |
| Custom Domain | `cflab.aismallbizguru.com` only |
| D1 binding `DB` | dedicated database `cflab` |
| R2 binding `FILES` | dedicated private bucket `cflab-files` |
| Health | `GET /api/health` → `{"status":"ok","service":"cflab"}` |

These names already exist in the project configuration and are reserved for CFLab. Do not substitute the old SQLite store, MinIO bucket, or LabBox R2 backup bucket. Resource ownership must be checked in your account before using an existing name; if a name is occupied by unrelated data, stop and select a distinct CFLab name rather than repurposing it.

## 1. Verify account and hostname ownership

Run from this repository:

```sh
npm ci
npm run check
npm run build
npx wrangler login
npx wrangler whoami
npx wrangler d1 list
npx wrangler r2 bucket list
```

Use the Cloudflare account that owns the active `aismallbizguru.com` zone and has Workers/D1/R2 available. Add its explicit `account_id` to `wrangler.jsonc` so future commands select the same account. Account/database IDs are configuration, not secrets. If the zone is not already active in that account, stop; do not change its nameservers as part of this deployment because that could affect LabBox.

In the Cloudflare dashboard, inspect **only** the intended `cflab.aismallbizguru.com` DNS entry and existing Worker Custom Domains/routes, including wildcard rules that might intercept it. Confirm that this new hostname is free. If it is occupied, resolve ownership before publishing; do not blindly overwrite it. Do not edit `lab.aismallbizguru.com` or broad zone routing/redirect rules.

`wrangler.jsonc` uses:

```json
"routes": [{ "pattern": "cflab.aismallbizguru.com", "custom_domain": true }]
```

A Custom Domain makes the Worker the origin. Cloudflare creates the hostname's DNS record and certificate when the custom domain is published; do not manually CNAME it to LabBox or workers.dev. An existing CNAME on the target hostname prevents creating the Custom Domain. See [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## 2. Create CFLab's dedicated data resources

Only when the verified names are unused:

```sh
npx wrangler d1 create cflab --config wrangler.jsonc
npx wrangler r2 bucket create cflab-files --config wrangler.jsonc
```

Record the new D1 ID. Replace **only** the all-zero `database_id` in `wrangler.jsonc` with that ID, retaining `binding: "DB"`, `database_name: "cflab"`, and `migrations_dir: "migrations"`. Keep the R2 binding `FILES` and bucket name `cflab-files`. Leave `wrangler.local.jsonc` local; it does not need the real remote ID. Once the remote ID is set, local migrations should explicitly use the local config, as the package script does.

For later deployments, reuse these exact CFLab resources instead of recreating them. Keep R2 public access disabled and do not configure a public bucket domain.

## 3. Review configuration and secrets

- Retain `src/index.ts`, `workers_dev: false`, and `preview_urls: false`. Never deploy the local entrypoint or upload `DEV_ADMIN_TOKEN`.
- Retain only the exact `cflab.aismallbizguru.com` Custom Domain; no `lab` hostname or wildcard.
- Leave proxies disabled unless needed. For audited upstreams, set exact `PROXY_ALLOWED_HOSTS`; review the [proxy threat model](ARCHITECTURE.md#proxy-threat-model). Put credentials in `PROXY_SECRETS`, not app config or source headers.
- Production administration is a normal human session whose user is an active administrator; there is no shared admin secret and no development bypass. The Worker can be published and health-checked before any user exists. Create the first administrator through the documented operator bootstrap in [AUTH.md](AUTH.md#first-admin-bootstrap), then manage users, memberships, and sessions through `/api/admin/*` or the minimal UI at `/admin/login`.
- Authentication mail uses the native `send_email` binding (`EMAIL`) with `AUTH_FROM_EMAIL` and `AUTH_PUBLIC_BASE_URL`. `AUTH_FROM_EMAIL` is intentionally empty until a sending domain is onboarded in **Compute > Email Service > Email Sending > Onboard Domain**; review the bounce MX/SPF/DKIM/DMARC records that Cloudflare proposes before applying them and do not disturb existing Email Routing or the current registrar MX/SPF records. Until then, forgot-password stays generic and admin setup mail returns `503 email_unavailable`; the operator bootstrap can use a directly inserted reset token instead. Rate-limit bindings `RL_LOGIN`, `RL_RECOVERY`, and `RL_RESET` are configured in `wrangler.jsonc`.
- The human auth system is the primary CFLab identity provider. Cloudflare Access is not required and is not part of this deployment. An initial pilot app can be provisioned through the authenticated admin API/UI, or through the narrowly scoped operator procedure in Section 5 targeting only the verified CFLab DB and storing token hashes, never plaintext tokens. Local administration only changes local D1; it does not provision deployed apps. See [pilot prerequisites](COMPATIBILITY.md#b--first-pilot-wildlife-pattern-lab-read-only).
- Set operational ownership, abuse limits, and backup/restore policy appropriate for persistent client data. This is not disposable staging; the current MVP has no automated backup or per-client rate-limit service.

If upstream secrets are required, after the initial Worker publication below and before enabling its proxy sources:

```sh
npx wrangler secret put PROXY_SECRETS --config wrangler.jsonc
```

Enter the JSON secret-name/value map interactively. Without a needed secret the proxy fails closed. Read-only compatibility tokens belong in your local environment/secret manager, never in fixtures or Git.

## 4. Apply migrations and publish explicitly

Review the account ID, D1 ID, bucket ownership, and sole Custom Domain again, then run:

```sh
npm run types
npm run check
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
npm run build
npx wrangler deploy --config wrangler.jsonc --no-x-provision
```

The final command publishes CFLab and configures **its** Custom Domain. It is deliberately not part of `npm run build`, tests, or CI. `--no-x-provision` disables implicit resource provisioning; resources were created explicitly above. Do not add overwrite-DNS flags if a conflict is reported. No command here imports LabBox data or changes its hostname.

After DNS/certificate activation:

```sh
curl --fail --silent --show-error https://cflab.aismallbizguru.com/api/health
```

Require exactly the CFLab identity (`service: "cflab"`), not just HTTP 200. Then verify non-destructively that human auth exists and fails closed:

```sh
curl --silent --show-error -o /dev/null -w '%{http_code}\n' https://cflab.aismallbizguru.com/api/auth/me
# expect 401
curl --silent --show-error -o /dev/null -w '%{http_code}\n' https://cflab.aismallbizguru.com/api/admin/users
# expect 401
curl --silent --show-error https://cflab.aismallbizguru.com/admin/login | head -c 200
# expect the login page, never a credential
```

Provision and validate consumers once the first administrator exists and the desired app/token setup process is ready. Use the [parallel migration plan](MIGRATION.md) before moving any existing data or consumers.

## 5. Operator bootstrap for the pilot app

Production administration uses human admin sessions (see [AUTH.md](AUTH.md)); the first administrator is created by operator bootstrap there. This section covers provisioning a pilot application and machine token when an operator prefers direct, Cloudflare-account-gated D1 access over the admin API. This is manual tooling, not a remote admin endpoint or an authentication bypass. Never deploy `src/local.ts`, never set `DEV_ADMIN_TOKEN`, and never point these commands at anything but the verified `cflab` database.

Generate a token locally and keep the plaintext only in your secret manager; D1 stores the SHA-256 hash, exactly as the admin routes do:

```sh
TOKEN="cfl_$(openssl rand -hex 32)"                 # save this value in your secret manager
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')   # sha256sum on Linux
PREFIX=${TOKEN:0:12}
TOKEN_ID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
```

Register the app and its exact frontend origin, then insert the scoped token. Adapt the app id, name, and origin to the audited client mapping (the example reuses the `wildlife-field-recorder` app id that Pattern Lab's observations/trips currently come from) and keep scopes minimal:

```sh
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "
INSERT INTO apps (id,name,active,config_json,created_at,updated_at) VALUES ('wildlife-field-recorder','Wildlife Field Recorder',1,'{}','$NOW','$NOW');
INSERT INTO app_origins (app_id,origin) VALUES ('wildlife-field-recorder','https://exact-frontend-origin.example');
INSERT INTO api_tokens (id,app_id,name,token_hash,prefix,scopes_json,created_at) VALUES ('$TOKEN_ID','wildlife-field-recorder','pattern-lab-read','$HASH','$PREFIX','[\"records:read\"]','$NOW');
"
```

Validate with a GET using the plaintext token (`Authorization: Bearer $TOKEN`) against `https://cflab.aismallbizguru.com/api/apps/wildlife-field-recorder/resources/observations/records?limit=1`, and revoke with an `UPDATE api_tokens SET revoked_at = ? WHERE app_id = ? AND id = ?`. To seed the approved snapshot, insert explicit UUIDs and timestamps into `records` with matching `app_id`/`resource` and object `data_json`; keep unapproved or precise-location payloads out, and never import LabBox data in this deployment pass. Pattern Lab's browser diagnostic must use this scoped read, not `/api/health`, because health has no CORS.

## 6. Rollback for this stage

No client depends on CFLab yet, so rollback touches only CFLab resources. LabBox DNS, routes, service, and data need no action.

- **Routing:** remove the `routes` entry from `wrangler.jsonc` and rerun `npx wrangler deploy --config wrangler.jsonc --no-x-provision`. This detaches `cflab.aismallbizguru.com` and leaves the Worker, D1, R2, and data in place. Do not edit `lab` DNS or routes.
- **Worker version:** `npx wrangler rollback <version-id> --name cflab --config wrangler.jsonc` after a bad later CFLab deployment.
- **Data:** this stage has no client writes. Establish the retention/recovery policy before the pilot writes anything; use D1/R2 exports rather than mutating LabBox.
- **Teardown (requires separate authorization):** `npx wrangler delete --name cflab --config wrangler.jsonc` removes only the Worker. D1 `cflab` and R2 `cflab-files` are separate and survive until deliberately deleted. Never delete, rename, or repurpose LabBox resources.

## Read-only parallel checks

The opt-in black-box suite uses Node's built-in test runner and fetch; it is separate from the Workers-compatible local binding tests. No additional dependency is needed. `npm run check` tests its safety/adapter helpers offline; neither ordinary tests nor CI contacts either live hostname.

After CFLab is deployed, explicitly run:

```sh
LABBOX_BASE_URL=https://lab.aismallbizguru.com \
CFLAB_BASE_URL=https://cflab.aismallbizguru.com \
npm run test:compat
```

This GETs **CFLab health only**; legacy health is skipped by default. LabBox's `/api/health` can create a missing MinIO bucket when storage checking is enabled. Only after confirming deployed `STORAGE_HEALTH_ENABLED=false`, set `COMPAT_LABBOX_HEALTH=1` to include its known DB/storage health contract. Do not use GET method alone as evidence of non-destructive behavior. The suite has no default remote origins and refuses matching origins, redirects, credential-bearing URLs, and non-HTTPS URLs except local loopback. Each response has a 10-second deadline and 1 MiB cap. No proxy, admin, backup, or write routes are probed.

For existing-record comparisons:

1. Copy `test/remote/fixtures.example.json` to ignored `test/remote/fixtures.local.json` and replace identifiers with up to 20 known corresponding records that already exist on both services. Apps/resources/IDs can differ across each pair. No data is created or deleted by the checks.
2. Supply separate `LABBOX_READ_TOKEN` and `CFLAB_READ_TOKEN` environment variables using your secret manager/shell; choose minimal read permissions. CFLab needs `records:read`. Never use admin/write tokens for these checks.
3. Run the same command with `COMPAT_FIXTURES=test/remote/fixtures.local.json` in the environment.

The adapters use legacy `/api/:app/:resource/:id` versus CFLab `/api/apps/:app/resources/:resource/records/:id`. They validate identity and compare only the `data` object, without printing payloads or credentials. For deliberate public-read checks, an individual side may set `"anonymous": true`; its token is then omitted even if configured. Current CFLab denies anonymous reads, so such probes correctly fail until an approved publishing solution exists.

To compare complete small collections, copy `test/remote/collections.example.json` to ignored `test/remote/collections.local.json`, choose corresponding resources with preserved record IDs, and set `COMPAT_COLLECTIONS=test/remote/collections.local.json`. The harness follows CFLab cursors, validates the legacy total, and compares ID/data independently of ordering. It fails beyond 10 pages / 1,000 rows per collection rather than silently truncating; use offline exports for larger datasets. Run against an agreed stable dataset; concurrent legacy writes can legitimately cause mismatches.

Optionally set `COMPAT_ORIGIN` to the exact frontend origin to check GET CORS response headers on record/collection probes. This does not test browser OPTIONS preflights. Metadata, binary files, chronological UI behavior, writes, and delete semantics still need separate acceptance work; passing these probes is not full compatibility. With no fixtures/collections, those comparisons are explicitly skipped. See [COMPATIBILITY.md](COMPATIBILITY.md#harness-scope-and-safe-operation) for limits and known differences.

## Future cutover boundary

Keep consumers' base URLs configurable and preserve relative file references. Complete API compatibility, token migration, and data reconciliation while both hosts are live. A separately approved future cutover can attach `lab.aismallbizguru.com` to the same CFLab Worker and existing D1/R2 bindings, while retaining the `cflab` hostname. Host-bound Access rules, certificates, existing DNS/route conflicts, and the final legacy write delta must be handled then. The old hostname is intentionally absent from current Wrangler routes.
