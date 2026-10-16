# CFLab agent guide

Read this first. It is the entry point for any coding agent working in this
repository, including a fresh session with no prior context. The release rules
below are engineering policy, not suggestions. The full runbook is
[CI-CD.md](docs/CI-CD.md); the resource history and the one-time creation
commands are in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Release policy: GitHub is authoritative

* **GitHub `main` is authoritative for production.** Whatever is merged on `main`
  is the intended production state. A developer machine, a local working tree, or
  an agent session is never a release source.
* **Never deploy uncommitted work.** A release must correspond to a commit that
  exists on `main`. If production is running something that is not committed,
  that is drift to be reconciled (commit it, or roll production back) — not a
  state to build on.
* **Production releases go through GitHub Actions** (`.github/workflows/ci.yml`):
  push to `main` → validate → deploy → verify. Both Workers (`cflab` and
  `cflab-analytics`) are released together by that pipeline.
* **All changes must pass CI** before they are released: `npm run check`,
  `npm run db:migrate`, `npm run db:migrate:analytics`, `npm run build`, and
  `npm run build:analytics`. The `validate` job must be green.
* **Every release is associated with a Git commit.** The pipeline passes the
  commit SHA as `DEPLOY_REVISION` and verifies it through `GET /api/version` on
  both origins. "The deploy succeeded" is not evidence that the intended release
  is live; the revision check is.
* **Direct Wrangler production deployment is reserved for documented
  emergencies** (GitHub outage, pipeline blocked). It requires a clean checkout
  whose `HEAD` equals `origin/main`, and it must use the same flags as the
  pipeline (`--no-x-provision`, `--tag`, `--var DEPLOY_REVISION:<sha>`), followed
  by `node scripts/verify-production.mjs --service all --revision <sha>`. The
  procedure is [CI-CD.md → Emergency manual deployment](docs/CI-CD.md#emergency-manual-deployment).
* **Deployment is gated.** The repository variable `CLOUDFLARE_DEPLOY_ENABLED`
  must be exactly `true` for the deploy job to run. Leave it as you found it:
  do not enable it to make a change appear in production, and do not remove,
  weaken, or bypass the gate, the preflight, the migration gate, or the
  production verification.
* **Migrations are never applied by hand as a shortcut.** The pipeline classifies
  every pending migration and fails closed on anything it cannot prove additive.
  Destructive or backward-incompatible changes need an explicit content-hashed
  approval in `.github/d1-migration-approvals.json`, and remote migrations must
  never be applied outside the pipeline without recording the Time Travel
  bookmark first (see [CI-CD.md → D1 recovery](docs/CI-CD.md#d1-recovery)).
* **Backups are the last line of defence, and they are verified by restoring.**
  Both D1 databases are exported daily and restored into an isolated database
  before anything is uploaded; `cflab-files` is mirrored append-only and
  content-addressed so a deletion or replacement cannot propagate. Never delete,
  overwrite, or "tidy" a stored backup, never write backups into `cflab-files`,
  and never restore into a production database as part of a test. The procedures
  and the retention policy are in
  [BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md).

## What an agent must not do

* Do not run `wrangler deploy`, `wrangler versions deploy`, or
  `wrangler rollback` against production.
* Do not run `wrangler d1 migrations apply … --remote`, `wrangler d1 execute …
  --remote` with writes, or any database reset, seed, or destructive statement.
* Do not modify production data, R2 objects, DNS records, routes, or Cloudflare
  secrets.
* Do not delete or overwrite objects in `cflab-files`, in the backup bucket, or in
  the legacy LabBox archive bucket; do not run a database restore against
  production as a test; do not treat an unverified backup as a backup.
* Do not delete legacy archives. `labs-smallbizguru-backups` holds the only
  pre-cutover LabBox history and is out of scope until a separate decision.
* Do not commit credentials, `.dev.vars`, `.env*` files, or generated secrets;
  `.dev.vars.example` documents the shape only.
* Do not force-push, reset, clean, or stash someone else's uncommitted work.
  Preserve unrelated changes and commit only what the task asks for.
* Do not weaken or delete a test to make a change pass, and do not loosen a
  scientific or security tolerance.

## Commands

Local development and validation are always safe and never deploy:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install exact pinned dependencies from `package-lock.json`. |
| `npm run check` | Full local validation (typecheck, tests, harnesses, release tooling). |
| `npm run db:migrate`, `npm run db:migrate:analytics` | Apply migrations to **local** D1 only (`wrangler.local.jsonc`). |
| `npm run build`, `npm run build:analytics` | Bundle both Workers with `wrangler deploy --dry-run`. Nothing is uploaded. |
| `npm run dev`, `npm run dev:analytics` | Local Wrangler dev servers on loopback. |
| `node scripts/verify-production.mjs --service all` | Read-only production verification. No writes. |
| `node scripts/verify-drift.mjs` | Read-only drift check: are both Workers on one committed revision? |
| `node scripts/backup/d1-export.mjs --out <dir>` | Export both databases and write manifests. Read-only against production. |
| `node scripts/backup/restore-verify.mjs --manifest <m>` | Restore a backup into an isolated local database and verify it. |
| `node scripts/backup/backup-status.mjs` | Read-only backup freshness report; fails when a backup is stale. |
| `node scripts/backup/r2-mirror.mjs --plan` | Plan the append-only file mirror (add `--apply` to copy). Never deletes. |
| `node scripts/backup/verify-setup.mjs` | Verify the backup bucket, lock/lifecycle rules, public access, and credentials before activation. |
| `npm run deploy` | **Refuses.** Prints this policy. Releases come from GitHub Actions. |

## Working agreement

* Inspect `git status`, the branch, and remotes before working; fetch before
  pushing; never force-push. Reconcile divergence instead of discarding it.
* Keep the existing conventions: strict TypeScript, Hono, no new runtime
  dependency unless clearly justified, tests that exercise real behavior, and
  documentation updated in the same commit as the change.
* Prefer the smallest change that satisfies the task. Do not add infrastructure,
  a second deployment path, or a parallel configuration.
* Report honestly: state what was verified, how, and what remains uncertain. If
  something could not be checked, say so instead of implying it passed.
