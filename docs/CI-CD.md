# Continuous deployment (GitHub Actions)

CFLab is released by **`.github/workflows/ci.yml`** in `hmarquardt/aismallbizguru-cflab`.
That workflow is the primary release mechanism: a merge to `main` validates the
repository, and — only when production deployment is deliberately enabled —
applies safe D1 migrations, publishes both Workers, and verifies production
read-only. Developer-machine `wrangler deploy` remains available as an emergency
procedure (see [Emergency manual deployment](#emergency-manual-deployment)), but
it is no longer the normal path. The rules themselves — what an agent or an
operator must and must not do — are stated in [AGENTS.md](../AGENTS.md), and
`npm run deploy` refuses and prints them rather than deploying anything.

Two Workers are released together:

| Worker | Config | Production origins | Storage |
| --- | --- | --- | --- |
| `cflab` | `wrangler.jsonc` | `cflab.aismallbizguru.com` (Custom Domain), `lab.aismallbizguru.com/*` (zone route) | D1 `cflab` (`DB`), D1 `cflab-analytics` (`ANALYTICS`), R2 `cflab-files` (`FILES`) |
| `cflab-analytics` | `wrangler.analytics.jsonc` | `analytics.aismallbizguru.com` (Custom Domain), `lab.`/`cflab.` `/api/analytics/collect*` (zone routes) | D1 `cflab-analytics` (`ANALYTICS`), service binding `CFLAB` → `cflab`/`HumanAuthService`, hourly cron |

Nothing in the workflow provisions infrastructure. Both deploys pass
`--no-x-provision`, so an implicit resource creation fails the release instead of
silently creating a replacement D1 database, R2 bucket, or route. Existing
resources, DNS, routes, and secret bindings are reused exactly as configured.

## The deployment gate

`CLOUDFLARE_DEPLOY_ENABLED` is a **repository variable** (Settings → Secrets and
variables → Actions → Variables), not a secret. The deploy job runs only when it
is exactly `true`:

```yaml
if: >-
  github.ref == 'refs/heads/main' &&
  github.event_name != 'pull_request' &&
  vars.CLOUDFLARE_DEPLOY_ENABLED == 'true'
```

* Unset, `false`, or any other value: validation runs, the deploy job is skipped.
* `true`: a push to `main` (or a manual run on `main`) validates and then deploys.
* Pull requests never deploy, whatever the variable says.

A push alone never publishes production. This is the only switch that turns
automatic production deployment on.

## Required GitHub configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Publish both Workers (`Workers Scripts: Edit`, `Workers Routes: Edit`; the same account as `wrangler.jsonc`). |
| `CLOUDFLARE_D1_API_TOKEN` | secret | List and apply D1 migrations on both databases (`D1: Edit`). Kept separate from the deploy token so the migration step cannot change Worker code and vice versa. |
| `CLOUDFLARE_DEPLOY_ENABLED` | variable | `false` disables production deployment; `true` enables it. |
| `CLOUDFLARE_ACCOUNT_ID` | workflow `env` | Public configuration (`b1aa310aa0a1638d72b8b086a21e557c`), identical to `wrangler.jsonc`. Not a secret. |

No other credential is required, and no credential is ever printed: the
preflight reports only whether a token is present. Repository secrets are
available to the deploy job's steps and to nothing else. Do not add a staging
account, a second Cloudflare token, or a copied local OAuth credential.

## What validation does (pull requests and every push)

`ubuntu-24.04`, Node.js 24, `npm ci` from the committed `package-lock.json`:

1. `npm run check` — strict TypeScript, the vendored Chart.js check, the
   Workers-compatible Vitest suite (real ephemeral D1/R2), dashboard UI tests,
   the offline remote-probe harness, the migration harness, and the release
   tooling tests (`test/ci/*`).
2. `npm run db:migrate` and `npm run db:migrate:analytics` — both migration sets
   are applied to ephemeral **local** storage, so a broken migration file fails
   validation before any release.
3. `npm run build` and `npm run build:analytics` — `wrangler deploy --dry-run`
   bundles for both Workers. Nothing is uploaded.
4. The validated bundles are uploaded as the `cflab-build` artifact and
   downloaded by the deploy job, which verifies they are present before touching
   production. Workers are deployed by re-bundling the same commit; the artifact
   is the preserved evidence of what validation produced.

## Release order

The deploy job follows one fixed order, and stops at the first failure:

1. **Validation confirmed** — the job requires the `validate` job (`needs: validate`).
2. **Deployment target and credentials verified** —
   `node scripts/ci/verify-deployment-target.mjs` compares both Wrangler configs
   against the intended production account, Workers, origins, D1 databases, R2
   bucket, `send_email` binding, rate-limit bindings, service binding, cron
   trigger, and `AUTH_FROM_EMAIL`; it also requires both tokens, the expected
   account ID, the released commit SHA, and both validated bundles. These
   expectations are deliberate guards: a release that would drop a binding or
   repoint a database stops here instead of changing production. If a change is
   intentional, update the expectation in the same reviewed commit.
3. **Pending migrations checked** — `node scripts/ci/migration-gate.mjs` lists the
   pending migrations for **both** D1 databases and classifies every file.
4. **Approved, additive migrations applied** —
   `node scripts/ci/migration-gate.mjs --apply` re-lists, re-classifies, applies,
   and then confirms nothing remains pending.
5. **Primary Worker deployed** — `wrangler deploy --config wrangler.jsonc
   --no-x-provision --tag <sha>`.
6. **Primary production verified** — health, deployment identity, authentication
   boundary, public projections, cutover hostname.
7. **Analytics Worker deployed** — `wrangler deploy --config
   wrangler.analytics.jsonc --no-x-provision --tag <sha>`. It is deployed after
   CFLab because its `CFLAB` service binding needs the `HumanAuthService`
   entrypoint that already exists in the new CFLab version.
8. **Analytics production verified** — health, deployment identity, dashboard
   assets, the CFLab service binding, and both collect routes.
9. **Release recorded** — `scripts/ci/release-summary.mjs` writes a summary whose
   **verdict** (`SUCCESS`, `FAILED`, or `INCOMPLETE`) and production-state line are
   derived from the actual step outcomes, so a failed or partial release can never
   read as a success. It names which Worker is live, which is not, whether the
   revision was verified, and each Cloudflare version ID (also shown in the
   Cloudflare dashboard as the version tag). The verdict logic is covered by
   `test/ci/release-summary.test.mjs`.

One release runs at a time (`concurrency: release-<ref>`,
`cancel-in-progress: false`), so two pushes cannot interleave deployments and an
in-progress release is never cancelled.

## Migration safety

D1 applies every pending migration in a directory in filename order, so the
pipeline must decide **before** it runs anything whether the pending set is safe.
`scripts/ci/migration-gate.mjs` is deliberately fail-closed.

**Classification.** Each pending file is scanned statement by statement, ignoring
comments and respecting string literals:

* `additive-safe` — `CREATE TABLE`/`INDEX`/`VIEW`, `INSERT OR IGNORE`, and
  `ALTER TABLE ... ADD COLUMN` (nullable, or `NOT NULL` with a constant
  `DEFAULT`). Applied automatically.
* `forbidden` — anything that destroys data or breaks an older Worker:
  `DROP TABLE/VIEW/TRIGGER/INDEX`, `ALTER TABLE ... DROP COLUMN`, `ALTER TABLE
  ... RENAME`, `DELETE FROM`, `TRUNCATE`, `UPDATE ... SET`, `INSERT OR REPLACE`,
  `REPLACE INTO`, `VACUUM`, `PRAGMA`, `ATTACH`/`DETACH`.
* `requires-approval` — everything the gate cannot prove additive, including
  `CREATE UNIQUE INDEX`, `CREATE TRIGGER`, `ALTER TABLE ... ADD COLUMN ... UNIQUE`,
  `NOT NULL` without a default, an upsert, and any unrecognized statement.

**Blocking.** If any pending file is `forbidden` or `requires-approval` without an
approval, the gate prints the file, the reason, and the exact operator action,
then fails the release. No Worker is deployed and no migration is applied. The
gate also fails closed when it cannot prove the situation: an unreadable
`wrangler d1 migrations list` output, a migration listed remotely but absent from
the checkout, an unreadable approvals file, or an unreachable database.

**Approvals.** `.github/d1-migration-approvals.json` records deliberate operator
approvals. An entry matches only when the database, the exact file name, and the
**SHA-256 of the file content** all match, so editing an approved migration
invalidates the approval and forces a new review:

```json
{
  "approved": [
    {
      "database": "DB",
      "file": "0011_example.sql",
      "sha256": "<node scripts/ci/migration-gate.mjs --print-hash migrations/0011_example.sql>",
      "reason": "Why this is safe for the data and the deployed Worker",
      "approved_by": "<operator>",
      "approved_at": "2026-10-15"
    }
  ]
}
```

Review an approval like code: it is a statement that the migration preserves
existing rows, is idempotent where it repeats work, and stays readable by the
Worker version currently in production (additive first, remove later). `npm run
check` also asserts that every committed migration is either additive or covered
by a matching approval, so an accidental `DELETE`/`DROP`/`UPDATE` added to a
migration file fails CI.

**Never automatic.** The pipeline has no database reset, no data seeding, no
destructive migration, and no R2 mutation. D1 captures a backup before applying
and rolls back a failed migration, so a blocked or failed migration leaves the
database as it was.

## Production verification

`scripts/verify-production.mjs` verifies production after each deploy. It is
read-only by construction:

* only `GET` requests, plus `POST` to the two analytics collector paths with a
  deliberately unmatched Site identifier — both implementations answer an unknown
  Site before writing anything, so **no analytics event is created**;
* no credentials are sent except two well-formed but unregistered values (an
  unknown machine token and an unknown session), which cannot match a row or a
  session and therefore reveal and change nothing;
* no account, session, record, file, R2 object, or email is created, changed, or
  deleted; no admin, backup, seed, or write route is probed.

What is checked:

| Service | Checks |
| --- | --- |
| `cflab` | `/api/health` is `{"status":"ok","service":"cflab"}`; `/api/version` reports the released revision; `/api/admin/apps` rejects unauthenticated access (401); `/api/apps/wildlife-field-recorder` rejects unauthenticated access and an unregistered machine token (401); the public Top Hat Ferals and Wildlife Safari projections answer 200 with their documented shape; `lab.aismallbizguru.com/api/health` still serves CFLab. |
| `cflab-analytics` | `/api/health` is `{"status":"ok","service":"cflab-analytics"}`; `/api/version` reports the released revision; `/` serves the dashboard HTML; `/api/sites` rejects unauthenticated access (401) and rejects an unknown session **through the `CFLAB` service binding** (401, where 503 would mean the binding is broken); `/collect` and `/api/analytics/collect` answer an unknown Site with 204 and an empty body; the same legacy collect route answers 204 on both `cflab.` and `lab.`, which proves the Analytics Worker owns those zone routes (the legacy CFLab collector answers 404 there). |

Failure categories are distinct, so a release problem is never confused with an
unrelated one: `network` (unreachable, DNS/TLS/timeout), `redirect` (a 3xx where a
direct response is required), `status` (unexpected HTTP status), `body`
(unexpected body, shape, or content type), `revision` (the deployed revision is
missing, `unknown`, or not this release), and `checks` (one or more probes
failed). Every probe runs on each attempt and all failures are reported together.
After a deploy the check set is retried for up to two minutes, because Cloudflare
can briefly serve the previous routing configuration from some regions; a partial
result is never accepted.

**Deployment identity.** Both Workers answer `GET /api/version` with
`{"service":"<worker>","revision":"<git sha>"}`. The revision comes from the
`DEPLOY_REVISION` variable that the workflow passes per release
(`wrangler deploy --var DEPLOY_REVISION:<sha>`); it is non-sensitive release
metadata, sanitized to a short identifier, and reports `unknown` when absent. The
deploy job fails if the deployed revision is `unknown` or different from the
commit it released, so "the deploy succeeded" can never be mistaken for "the
intended release is live".

## Running the workflow manually

* **Validate only:** run the `validate and deploy` workflow from the Actions tab
  (or `workflow_dispatch`) with `CLOUDFLARE_DEPLOY_ENABLED` unset/`false`. The
  deploy job is skipped.
* **Release on demand:** set `CLOUDFLARE_DEPLOY_ENABLED=true`, run the workflow on
  `main`, and set it back to `false` afterwards.
* **Verify production at any time, locally:**

  ```sh
  node scripts/verify-production.mjs --service all
  node scripts/verify-production.mjs --service cflab --revision <sha>
  node scripts/verify-drift.mjs
  ```

  Without `--revision` the identity checks still confirm the service and report
  the deployed revision. These commands make no changes.
* **Drift check:** run the `production drift check` workflow (Actions →
  `production drift check` → Run workflow), or `node scripts/verify-drift.mjs`
  locally. It runs daily on its own and reports whether production is on a
  revision published from `main`.
* **Inspect the pending migration decision locally** (needs the D1 token in the
  environment; it never applies anything without `--apply`):

  ```sh
  CLOUDFLARE_D1_API_TOKEN=<token> node scripts/ci/migration-gate.mjs
  CLOUDFLARE_D1_API_TOKEN=<token> node scripts/ci/migration-gate.mjs --apply
  ```
* **Check the deployment target without credentials:**
  `node scripts/ci/verify-deployment-target.mjs --config-only`.

## Enabling the first automated release

Do this only after the blocking item below is resolved.

> **Reconciliation status (2026-10-15).** The drift found during the Phase 1
> audit is resolved. The transactional-email and invitation work that production
> has been serving since 2026-10-06 (Worker version 19) is committed as
> `9dad7ba`, together with migration `0010_auth_email_invitations.sql`, which was
> already applied in the remote `cflab` database. `main` is now ahead of
> production only by the additive `GET /api/version` route introduced with this
> pipeline, which the first release publishes. Everything else was verified to
> match the live deployment before committing (deployed bindings, byte-identical
> pages, invite-token behaviour, migration state); the method and the remaining
> differences are recorded in [Known limitations and drift](#known-limitations-and-drift).

1. Confirm the reconciled state on `main`: `npm run check` passes, and
   `node scripts/ci/verify-deployment-target.mjs --config-only` prints
   `PASS: 30 deployment-target checks passed`.
2. Confirm the repository variable `CLOUDFLARE_DEPLOY_ENABLED` is `false` and both
   secrets exist.
3. Confirm the release pipeline's `validate` job passes on `main`.
4. Confirm the recovery mechanism is usable — both databases must answer
   `npx wrangler d1 time-travel info <DB>` with a bookmark (see
   [D1 recovery](#d1-recovery)).
5. Confirm the remote migration state is fully applied — both databases must
   report no pending migrations:

   ```sh
   npx wrangler d1 migrations list DB --remote --config wrangler.jsonc
   npx wrangler d1 migrations list ANALYTICS --remote --config wrangler.analytics.jsonc
   ```
6. Set `CLOUDFLARE_DEPLOY_ENABLED=true`.
7. Push a trivial, reviewed commit to `main` (or run the workflow manually on
   `main`) and watch the run: the deploy job publishes both Workers and verifies
   production. The first release also publishes `GET /api/version`, so the
   revision check becomes meaningful from then on.
8. Confirm the run summary, `GET /api/version` on both origins, and the Cloudflare
   version tags, then decide whether to leave deployment enabled. Leaving it
   enabled means every merge to `main` releases to production.

## Disabling deployments

Set the repository variable `CLOUDFLARE_DEPLOY_ENABLED` to `false` (or delete it).
The deploy job then skips and only validation runs. This is the immediate stop
switch and needs no code change; an already-running release is not cancelled.

## D1 recovery

D1 **Time Travel** is the recovery mechanism for a bad migration or a mistaken
write. It is always on, costs nothing, and is available on both CFLab databases —
verified 2026-10-15 with `wrangler d1 time-travel info`, which returned a bookmark
for `DB` (`cflab`, 12 tables, 12 MB) and `ANALYTICS` (`cflab-analytics`, 16
tables, 692 kB). Retention is **30 days** on the Workers Paid plan (7 days on
Free); bookmarks older than the window cannot be used.

```sh
# Read-only: show the current bookmark (or the bookmark for a past moment)
npx wrangler d1 time-travel info DB --config wrangler.jsonc
npx wrangler d1 time-travel info DB --config wrangler.jsonc --timestamp=1780000000
npx wrangler d1 time-travel info ANALYTICS --config wrangler.analytics.jsonc

# Destructive: restore the database in place to that point in time
npx wrangler d1 time-travel restore DB --config wrangler.jsonc --bookmark=<bookmark>
npx wrangler d1 time-travel restore ANALYTICS --config wrangler.analytics.jsonc --bookmark=<bookmark>
```

* `d1 time-travel info` takes no `--remote` flag; it always acts on the remote
  database. It changes nothing.
* A restore **overwrites the database in place** and cancels in-flight queries.
  It prints the previous bookmark, which is the undo path, and it does not remove
  older bookmarks, so a restore is itself reversible.
* The migration gate records the pre-migration bookmark (and the post-apply one)
  in the run summary whenever it applies migrations, so the exact undo point is
  recorded with the release. A bookmark that cannot be read is reported as a
  warning rather than silently omitted; it never blocks an otherwise safe release.
* `npx wrangler d1 export DB --remote --output backup.sql` produces a logical SQL
  dump (add `--table` to scope it, `--no-data`/`--no-schema` to split it). Keep
  dumps outside the repository; they contain production data.
* The legacy snapshot backup API (`wrangler d1 backup …`, hourly, 24-hour
  retention) applies only to `version: alpha` databases. Time Travel is the
  mechanism for these databases.
* Restoring data is always a deliberate operator action. No workflow, migration,
  or script in this repository restores, drops, truncates, or seeds a database.

## Drift detection

`scripts/verify-drift.mjs` (and the scheduled, read-only
`.github/workflows/drift.yml`) answers one question without any credential: **is
production running a revision that was published from `main`?** Both Workers
report their released revision at `GET /api/version`, so the check only reads two
public endpoints and then compares that revision against this clone's history
(the workflow checks out with `fetch-depth: 0`).

| Situation | Verdict | Result |
| --- | --- | --- |
| Production equals `main` | `in-sync` | pass |
| Production is an ancestor of `main` | `behind` | pass — a release is pending, which is normal |
| Production's revision is not in `main`'s history | `drift` | **fail** — it was not published from `main` |
| The two Workers are on different revisions | `split` | **fail** — a release was interrupted or one Worker was deployed by hand |
| A Worker reports `unknown` or an unusable revision | `unknown-revision` | **fail** — not published by this pipeline |
| Ancestry could not be checked in this clone | `unverified` | **fail** — never assumed to be fine |

Run it locally with `node scripts/verify-drift.mjs` (optionally
`--main origin/main`, `--primary <origin>`, `--analytics <origin>`). Being behind
is reported as information; only divergence, a split, or an unreported revision
fails. The scheduled run has `permissions: contents: read`, uses no secrets, and
cannot deploy or write anything.

## Rollback

Cloudflare keeps every published version, so rollback is a version deploy:

```sh
# List recent versions and their tags (the tag is the released Git revision)
npx wrangler versions list --name cflab --config wrangler.jsonc
npx wrangler versions list --name cflab-analytics --config wrangler.analytics.jsonc

# Roll back one Worker to a previous version
npx wrangler rollback <version-id> --name cflab --config wrangler.jsonc
npx wrangler rollback <version-id> --name cflab-analytics --config wrangler.analytics.jsonc
```

Limitations to keep in mind:

* **Migrations are not rolled back.** A rollback restores Worker code only. This
  is why migrations must stay backward compatible with the previously deployed
  version (additive first; drop or rewrite in a later release). If a release
  applied a migration the older version cannot read, roll the Worker back **and**
  forward-fix the migration.
* **Rollback is a manual decision.** The pipeline never rolls back by itself. A
  failure before the deploy step leaves production untouched; a verification
  failure after a successful deploy needs an explicit rollback.
* **Routes are configuration, not code.** Rolling back the Analytics Worker does
  not remove its routes. To return the collect paths to the legacy CFLab
  collector, remove those `routes` entries and redeploy — see
  [ANALYTICS.md](ANALYTICS.md#rollback).
* **D1 backups** exist per applied migration (`wrangler d1 time-travel`, plus the
  automatic pre-migration backup), but restoring data is a deliberate operator
  action, never part of a release.

## Emergency manual deployment

Use this only when the pipeline itself is blocked (for example a GitHub outage),
and keep the same order and checks:

```sh
git fetch origin && git switch main && git pull --ff-only
# Preconditions: no uncommitted work, and HEAD is exactly what GitHub has.
git status --porcelain           # must print nothing
git rev-parse HEAD origin/main   # must print the same SHA twice
npm ci
npm run check
node scripts/ci/verify-deployment-target.mjs --config-only

# Migrations: review the classification first, then apply deliberately
CLOUDFLARE_D1_API_TOKEN=<token> node scripts/ci/migration-gate.mjs
CLOUDFLARE_D1_API_TOKEN=<token> node scripts/ci/migration-gate.mjs --apply

# Publish both Workers with the same flags the pipeline uses
npx wrangler deploy --config wrangler.jsonc --no-x-provision --tag "$(git rev-parse HEAD)"
npx wrangler deploy --config wrangler.analytics.jsonc --no-x-provision --tag "$(git rev-parse HEAD)"

# Verify exactly what the pipeline verifies
node scripts/verify-production.mjs --service all --revision "$(git rev-parse HEAD)"
```

Keep `--no-x-provision` (never provision replacements), keep `--tag` (so the
release stays identifiable), never deploy `wrangler.local.jsonc` or `src/local.ts`,
and never edit DNS, routes, R2 objects, or secrets as part of an emergency deploy.
Record the manual deploy in the next commit message so the repository keeps the
release history. `npm run deploy` deliberately refuses; this section is the only
place these commands are documented, and they exist for a blocked pipeline rather
than for convenience.

## Known limitations and drift

* **Backups are implemented but not activated.** The scheduled backup workflow is
  gated by `CFLAB_BACKUPS_ENABLED` and needs the operator to create the backup
  bucket and credentials first
  ([BACKUP-RESTORE.md §5](BACKUP-RESTORE.md#5-credentials-and-cloudflare-setup)).
  Until then, D1 Time Travel is the only recovery mechanism, and `cflab-files` has
  no protection against an accidental delete or overwrite.
* **Source and production are reconciled (2026-10-15).** The email/invitation work
  is committed (`9dad7ba`) and matches the live deployment; `main` is ahead of
  production only by the additive `GET /api/version` route, so the first release
  publishes that route and nothing else changes behaviorally. Verification used
  four independent read-only methods: (1) the deployed version's bindings and
  vars read through `wrangler versions view` match `wrangler.jsonc` in all 16
  entries; (2) all five server-rendered pages (`/admin/login`, `/admin/users`,
  `/account`, `/forgot-password`, `/reset-password`) are byte-identical to this
  source; (3) an invite-purpose (`cfri_`) token is rejected with the new message;
  (4) both databases report no pending migrations. The deployed script's `etag`
  could not be used for byte-level proof: it is not reproducible from a locally
  built bundle even for the unchanged Analytics Worker, so it is not a source
  digest.
* **Two verification probes depend on production data**: the public projections
  require the `wildlife-field-recorder` and `top-hat-ferals` apps to exist, and
  the protected-app probe uses `/api/apps/wildlife-field-recorder`. If those apps
  are ever retired, update `scripts/verify-production.mjs` in the same reviewed
  change.
* **The legacy CFLab collector still serves `POST /api/analytics/collect`** if the
  Analytics zone routes are removed; the collect-route checks would then report a
  `status` failure rather than silently accepting the fallback.
* **Deployment stays disabled until an operator enables it.** The pipeline is
  merged and validated, but `CLOUDFLARE_DEPLOY_ENABLED` must remain `false` until
  the steps above are completed deliberately.
