# Backup, retention, and recovery

CFLab's persistent data is two D1 databases (`cflab`, `cflab-analytics`) and one
private R2 bucket (`cflab-files`). This document is the inventory, the design, the
retention policy, the credential setup, and the recovery procedures. The release
runbook is [CI-CD.md](CI-CD.md); the policy agents must follow is
[AGENTS.md](../AGENTS.md).

**Principle: a backup is not operational until a restore has been demonstrated.**
Every scheduled run therefore restores both exports into isolated databases and
compares them with their manifests *before* uploading anything
(`scripts/backup/restore-verify.mjs`).

## 1. Inventory (verified 2026-10-16)

Verified facts were read from the live account with read-only commands
(`wrangler d1 info`, `wrangler d1 execute … SELECT`, `wrangler r2 bucket info`,
`wrangler d1 time-travel info`, `wrangler d1 export`).

### D1 databases

| Database | Id | Size | Tables | Rows | Created |
| --- | --- | --- | --- | --- | --- |
| `cflab` (`DB`) | `cb2d2eb4-2817-4581-8e50-d69212650adf` | 12 MB | 12 | 2,746 (4 apps, 1,336 records, 1,325 files, 2 users, 16 sessions, 10 migrations, 44 safari projection rows) | 2026-09-18 |
| `cflab-analytics` (`ANALYTICS`) | `54e8af8e-3345-40e7-88fd-462a688421b5` | 692 kB | 16 | 1,268 (387 analytics events, 297 pageviews, 131 sessions, 53 visitors, 3 sites, plus daily aggregates) | 2026-09-18 |

Export size measured on 2026-10-16: `cflab` 11,269,440 bytes, `cflab-analytics`
696,164 bytes. Both databases are in `ENAM`, storage version `production` (Time
Travel supported; the legacy snapshot API does not apply).

### R2 buckets

| Bucket | Created | Objects | Size | Role |
| --- | --- | --- | --- | --- |
| `cflab-files` | 2026-09-18 | 1,329 | 267 MB | **Production CFLab files** (`FILES` binding, private) |
| `labs-smallbizguru-backups` | 2026-05-15 | 529 | 293 MB | **Legacy LabBox backups** (see §8) |
| `fruiting-forecast-data` | 2026-09-17 | 3,808 | 274 MB | Unrelated project |
| `roadnaturalist-data` | 2026-09-26 | 44,279 | 10.7 GB | Unrelated project |

Total R2 usage ≈ 11.5 GB. The `files` table records 1,325 rows totalling
266,972,411 bytes, while `cflab-files` holds 1,329 objects: **four objects are not
tracked by the table** (newer uploads or orphans). That is a pre-existing
discrepancy, recorded here rather than changed.

### Existing recovery capability (before this phase)

* **Time Travel** was available on both databases and is the only point-in-time
  mechanism; no independent copy existed.
* **No scheduled backup existed.** `wrangler d1 export` was used manually during
  the migration (`.migration/snapshots`, `migration-reports/`) and never retained
  outside the developer machine.
* **No R2 protection existed.** No bucket lock, no lifecycle rule, no mirror;
  `cflab-files` has no versioning, so an overwrite or delete is unrecoverable.
* Assumptions corrected during the audit: `wrangler r2 object list` does not
  exist (object listing is S3-API only); `PRAGMA integrity_check` and
  `PRAGMA user_version` are not authorized in D1 (`quick_check` and
  `foreign_key_check` are); `wrangler d1 export` mixes quoted and unquoted
  identifiers; `d1 time-travel info` takes no `--remote` flag.

## 2. Architecture

**Selected: GitHub Actions (scheduled, credential-gated) using `wrangler d1
export` for the databases and a small dependency-free S3 client for R2.**

| Decision | Why |
| --- | --- |
| GitHub Actions over a Worker Cron Trigger | A Worker cannot call the D1 export API without embedding a Cloudflare API token in the Worker, and R2 object listing/copying is S3-only. GitHub Actions already owns releases, keeps the scripts versioned, needs no always-on compute, and gives per-run logs and failure reporting. |
| `wrangler d1 export` over the async REST API | Both are supported; the CLI export is synchronous and simple, and at 12 MB it completes in seconds. The REST API is the documented path for very large databases. |
| Logical exports over Time Travel alone | Time Travel is in-database and bounded (30 days paid / 7 days free). An independent artifact in a separate bucket survives a database deletion, a bad migration, or a compromised production credential. |
| Append-only content-addressed R2 mirror | A plain mirror propagates deletions. `files/<sha256>/<key>` keeps every version, survives deletion and replacement, and makes integrity verification a hash comparison. |
| Separate backup and restore credentials | The scheduled job can export and write backups; only a manually dispatched drill has D1 write access. |
| No new dependency | The S3 client is ~150 lines of SigV4 verified against AWS's published test vector, instead of a new SDK dependency. |

Deliberately rejected: a Worker/Workflow exporter (token inside the Worker, more
moving parts), a third-party backup SaaS (cost, another credential, no need at
12 MB), and bucket-lock on the *production* bucket (it would block the
application's legitimate file deletions).

### Cost (current volume)

| Item | Quantity | Free tier | Monthly cost |
| --- | --- | --- | --- |
| D1 backup storage (90-day retention) | ≈ 1.1 GB | n/a (R2) | $0.00 |
| R2 file mirror | ≈ 0.3–0.6 GB | 10 GB | $0.00 |
| R2 Class A operations (PUT: ~12 objects + manifest per run) | ≈ 400/month | 1M | $0.00 |
| R2 Class B operations (LIST/GET/HEAD) | ≈ 50k/month | 10M | $0.00 |
| D1 export API calls, Time Travel | — | included | $0.00 |
| GitHub Actions minutes (≈ 8 min/day on a public repo) | — | free | $0.00 |

**Estimated total: $0.00/month** at the current volume. Beyond the free tier the
marginal cost is $0.015/GB-month for storage and $4.50 per million Class A
operations, so even a 10× growth stays under $1/month. No new billable resource is
created by this phase.

### RPO and RTO targets

| Scenario | Recovery point objective | Recovery time objective |
| --- | --- | --- |
| Accidental row change or deletion | minutes (Time Travel, 30 days) | < 15 min |
| Bad migration | to just before the migration (pre-migration bookmark is recorded in the release summary) | < 15 min |
| Database corruption or loss | ≤ 24 h (daily logical backup) | < 1 h |
| Accidental object deletion or replacement | ≤ 24 h (mirror run), any earlier version preserved | < 15 min for one object |
| Full loss of the Cloudflare account | ≤ 24 h, and only if the backup bucket is exported off-account | hours — out of scope, documented as a limitation |

Daily is adequate for a workload of ~2,700 database rows and 267 MB of files, and
the cron can be tightened (for example `17 */6 * * *`) without changing anything
else; the cost impact is negligible.

## 3. Retention policy

| Data | Retention | Enforced by |
| --- | --- | --- |
| D1 logical backups (`d1/…`) | **90 days** | R2 lifecycle rule `expire-d1-backups` (operator-created, see §5) |
| R2 mirror objects (`files/…`) | **400 days** | R2 lifecycle rule `expire-file-mirror` |
| R2 mirror manifests (`files/manifests/…`) | 400 days | same rule |
| Minimum protection against deletion/overwrite | **30 days** | R2 bucket lock rule `protect-d1-backups` (prefix `d1/`) and `protect-file-mirror` (prefix `files/`) |
| Time Travel (in-database PITR) | 30 days paid / 7 days free | Cloudflare |

Two properties matter here:

1. **The backup job never deletes.** There is no delete code path in
   `scripts/backup/` (a test asserts the client exposes none), so retention is
   enforced by the bucket's lifecycle rule, not by the script. A compromised
   backup credential cannot shorten retention through this tooling.
2. **Bucket locks outrank lifecycle rules.** A lock rule makes objects
   undeletable and unoverwritable for its window, so even a mistaken lifecycle
   rule or a direct API call cannot remove the newest backups. Lock rules apply to
   existing and new objects and can be removed later, so they are a strong guard,
   not a permanent commitment.

## 4. What the scheduled workflow does

`.github/workflows/backup.yml` runs daily at 03:37 UTC and on demand, and each job
is gated by the repository variable `CFLAB_BACKUPS_ENABLED == 'true'`:

1. `d1-export.mjs` — read-only introspection, then `wrangler d1 export` for both
   databases, structural verification, SHA-256, manifest, and a checksum file.
2. `restore-verify.mjs` — restores each export into an isolated local D1, then
   compares tables, row counts, `PRAGMA quick_check`, and `PRAGMA foreign_key_check`
   with the manifest. **An export that does not restore is never uploaded.**
3. `upload-backups.mjs` — uploads the verified artifacts with date-stamped keys.
   The client refuses to overwrite an existing object and refuses to write into
   `cflab-files` or the legacy LabBox backup bucket.
4. `backup-status.mjs` — fails the run when either database has no backup younger
   than 30 hours.
5. The `files` job mirrors production objects with `r2-mirror.mjs --apply` and
   verifies a 25-object sample.

The workflow never deploys, never migrates, and never writes to production: the
D1 job only reads, and the mirror only reads `cflab-files`.

## 5. Credentials and Cloudflare setup

None of this is applied yet: it is the exact setup the operator runs once before
setting `CFLAB_BACKUPS_ENABLED=true`. Nothing here is a secret in the repository —
all values live in GitHub secrets and repository variables.

### 5.1 Create the backup bucket (done 2026-10-16; reproducible with these commands)

```sh
npx wrangler r2 bucket create cflab-backups

# Lock rules and lifecycle rules are applied with `set`, not `add`:
# `wrangler r2 bucket lock|lifecycle add` REPLACES the whole configuration in
# wrangler 4.135, so adding a second rule silently drops the first.
npx wrangler r2 bucket lock set cflab-backups --file lock.json
npx wrangler r2 bucket lifecycle set cflab-backups --file lifecycle.json
```

`lock.json` (30-day protection for both backup prefixes):

```json
{ "rules": [
  { "id": "protect-d1-backups", "enabled": true, "prefix": "d1/", "condition": { "type": "Age", "maxAgeSeconds": 2592000 } },
  { "id": "protect-file-mirror", "enabled": true, "prefix": "files/", "condition": { "type": "Age", "maxAgeSeconds": 2592000 } }
] }
```

`lifecycle.json` (90-day D1 retention, 400-day mirror retention, plus the default
multipart abort rule that `set` must preserve):

```json
{ "rules": [
  { "id": "Default Multipart Abort Rule", "enabled": true, "conditions": {},
    "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } } },
  { "id": "expire-d1-backups", "enabled": true, "conditions": { "prefix": "d1/" },
    "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 7776000 } } },
  { "id": "expire-file-mirror", "enabled": true, "conditions": { "prefix": "files/" },
    "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 34560000 } } }
] }
```

Verify with the authoritative configuration rather than the CLI rendering:
`curl -H "Authorization: Bearer $CF_API_TOKEN" …/r2/buckets/cflab-backups/lock`
(and `…/lifecycle`), or `node scripts/backup/verify-setup.mjs`.

Leave public access **disabled**; do not create a custom domain or r2.dev URL.

### 5.2 Create the credentials (three, with separate authority)

| GitHub secret / variable | Kind | Permissions | Used by |
| --- | --- | --- | --- |
| `CFLAB_BACKUP_D1_TOKEN` | Cloudflare API token | **D1: Read** on the account (no write) | `backup.yml` export step |
| `CFLAB_BACKUP_SOURCE_R2_ACCESS_KEY_ID` / `CFLAB_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY` | R2 API token (**Object Read**) scoped to `cflab-files` only | read production objects | mirror source |
| `CFLAB_BACKUP_R2_ACCESS_KEY_ID` / `CFLAB_BACKUP_R2_SECRET_ACCESS_KEY` | R2 API token (**Object Read & Write**) scoped to `cflab-backups` only | upload, status, mirror destination, restore reads | `backup.yml`, restore |
| `CFLAB_RESTORE_D1_TOKEN` | Cloudflare API token | **D1: Edit** (needed only to create the temporary drill database) | `restore-drill.yml`, manual restores |
| `CFLAB_BACKUP_BUCKET` | repository variable | `cflab-backups` | workflow configuration |
| `CFLAB_BACKUPS_ENABLED` | repository variable | `false` until activated | gates every backup job |

An R2 API token carries a **single** permission level, so production reads and
backup writes cannot share one credential: `cflab-files` gets a read-only token
and `cflab-backups` gets a read/write token. `verify-setup.mjs` fails when the two
pairs are identical, and the mirror refuses to fall back to the write-capable pair
for production. Cloudflare's R2 permissions cannot express "write but never
delete", so deletion is prevented by the bucket lock rules, by the absence of any
delete call in the tooling, and by keeping these credentials out of every other
workflow. The production deploy token (`CLOUDFLARE_API_TOKEN`) is deliberately
**not** used for backups, and the backup credentials are not used for releases.

Create them in the dashboard (token creation is not available to the OAuth
credential this repository's tooling uses):

1. **My Profile → API Tokens → Create Token → Custom token**
   * `D1: Read`, Account resources: the `b1aa310aa0a1638d72b8b086a21e557c` account → save as `CFLAB_BACKUP_D1_TOKEN`.
   * (separately) `D1: Edit` → save as `CFLAB_RESTORE_D1_TOKEN`.
2. **R2 → Manage R2 API Tokens → Create API Token**
   * Permissions **Object Read**, *Specify bucket* `cflab-files` → save the Access Key ID and Secret Access Key as the SOURCE pair.
   * Permissions **Object Read & Write**, *Specify bucket* `cflab-backups` → save as the backup pair.

### 5.3 Activate

Everything below is required once; nothing runs until it is done.

1. **Create the four credentials** in the Cloudflare dashboard (§5.2).
2. **Add them to GitHub** (Settings → Secrets and variables → Actions):
   * Secrets: `CFLAB_BACKUP_D1_TOKEN`, `CFLAB_BACKUP_SOURCE_R2_ACCESS_KEY_ID`,
     `CFLAB_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY`, `CFLAB_BACKUP_R2_ACCESS_KEY_ID`,
     `CFLAB_BACKUP_R2_SECRET_ACCESS_KEY`, `CFLAB_RESTORE_D1_TOKEN`.
   * Variables: `CFLAB_BACKUP_BUCKET=cflab-backups`, `CFLAB_BACKUPS_ENABLED=false`.
3. **Verify:** `node scripts/backup/verify-setup.mjs --probe-write` — it must print
   `PASS`. It checks the bucket, the lock and lifecycle rules, public access,
   production read (with its own read-only credentials), backup read/write, and
   that the two credential pairs are different.
4. **First backup.** Either run the `production backups` workflow by hand, or run
   the same steps locally in one line (no GitHub needed) with the values exported
   in your shell:

   ```sh
   node scripts/backup/d1-export.mjs --out backups \
     && for m in backups/*.manifest.json; do node scripts/backup/restore-verify.mjs --manifest "$m" --work-dir backups/restore; done \
     && node scripts/backup/upload-backups.mjs --dir backups \
     && node scripts/backup/backup-status.mjs --max-age-hours 30
   ```

5. **Enable the schedule** by setting `CFLAB_BACKUPS_ENABLED=true` once step 4 is
   green, so the daily 03:37 UTC run starts.
6. **Drill.** Run `restore drill` with `mode=prepare` first (downloads, verifies,
   and restores the newest backup locally, creating nothing), then `mode=execute`
   with `confirm=RESTORE-DRILL`, verify the result, and tear the temporary
   databases down with the command the run prints. Repeat quarterly.

## 6. Recovery procedures

### 6.1 One database, from a logical backup

```sh
# 1. Fetch the newest stored backup and verify it against its manifest
R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… CFLAB_BACKUP_BUCKET=cflab-backups CLOUDFLARE_ACCOUNT_ID=b1aa310aa0a1638d72b8b086a21e557c \
  node scripts/backup/download-backup.mjs --database cflab --out recovery

# 2. Restore it into an isolated database first, and look at the result
node scripts/backup/restore-verify.mjs --manifest recovery/cflab-*.manifest.json --work-dir recovery/drill

# 3. Restore into production only when that is the deliberate decision
CLOUDFLARE_API_TOKEN=… npx wrangler d1 execute DB --remote --config wrangler.jsonc --file recovery/cflab-<stamp>.sql -y
```

Step 3 is the only production-writing command in this document. It replaces rows
in place; it does not drop the schema. For a partial recovery, extract the needed
`INSERT` statements from the SQL file and run those instead of the whole file.

### 6.2 A single object

```sh
# List what the mirror holds for one source key (content-addressed by SHA-256)
node -e "…" # or use any S3 client with the backup credentials
# Copy the version you want back into production
aws s3 cp --endpoint-url https://<account>.r2.cloudflarestorage.com \
  s3://cflab-backups/files/<sha256>/<original/key> s3://cflab-files/<original/key>
```

`wrangler r2 object get cflab-backups/files/<sha256>/<key> --file <path>` then
`wrangler r2 object put cflab-files/<key> --file <path> --force` also works without
an S3 client. Restoring one object does not require touching any database.

### 6.3 Point-in-time recovery (no backup needed)

```sh
npx wrangler d1 time-travel info DB --config wrangler.jsonc                 # current bookmark
npx wrangler d1 time-travel restore DB --config wrangler.jsonc --bookmark=<bookmark>
```

This is destructive in place and cancels in-flight queries; it prints the previous
bookmark as the undo path. See [CI-CD.md → D1 recovery](CI-CD.md#d1-recovery).

### 6.4 Limitations

* A restore replaces data; it is not a merge, and it does not roll back schema.
* The logical backup is a snapshot of one moment: rows written after it are lost
  unless Time Travel is used as well.
* The mirror preserves object bytes, not the `files` table rows; restoring a file
  that the database no longer references needs a matching database restore or a
  manual row insert.
* Backups live in the same Cloudflare account, so account-level loss (or loss of
  the credentials) is not covered. Exporting the backup bucket off-account
  periodically is a documented follow-up, not something this phase implements.

## 7. Restoration drill results

Two kinds of evidence, clearly separated.

### 7.1 Actual restores performed (real data, isolated target, 2026-10-16)

Both production databases were exported and restored into **isolated local D1
databases** (`--persist-to` into a private state directory). This is a real
restore of real production data into a real SQLite database, not a simulation:
the SQL artifact was loaded by `wrangler d1 execute --file` and then queried.

| Check | `cflab` | `cflab-analytics` |
| --- | --- | --- |
| Artifact size / SHA-256 verified against the manifest | 11,269,440 bytes / `6b5a87aa…` ✔ | 696,164 bytes / `3c287493…` ✔ |
| Tables restored | 12 of 12 ✔ | 16 of 16 ✔ |
| Row counts vs manifest | all equal (2,746 rows) ✔ | all equal (1,268 rows) ✔ |
| `PRAGMA quick_check` | `ok` ✔ | `ok` ✔ |
| `PRAGMA foreign_key_check` | 0 violations ✔ | 0 violations ✔ |
| Representative record | newest `files` row byte-identical, including its SHA-256 checksum ✔ | analytics site/event rows present ✔ |
| Migration ledger | 10 migrations, latest `0010_auth_email_invitations.sql`, identical to production ✔ | — |
| Restore duration | 10.7 s (plus ~1–2 s wrangler startup) | 4.1 s |
| Verification duration | 3.8 s | 3.6 s |

The `files` total restored (266,972,411 bytes) is identical to the live database,
which is the strongest available evidence that the export is complete.

### 7.2 Not yet performed — needs operator authorization

* **Remote restore into a temporary D1 database.** The workflow
  (`restore-drill.yml`) and the script support it, and the script refuses
  production targets, but running it creates a billable D1 database, so it is
  waiting for the operator. Expected duration: 2–5 minutes for `cflab`.
* **R2 mirror round-trip.** The mirror needs S3 credentials, which do not exist
  yet; its logic is covered by tests (content addressing, never-overwrite,
  corruption detection) but has not touched real objects. A real drill is the
  first `files` job run after activation, plus `--verify`.
* **Time Travel restore** was deliberately not exercised: it is destructive
  against the live database and is documented as an operator action only.

## 8. Legacy LabBox archives (inventory only — nothing deleted)

`labs-smallbizguru-backups` (created 2026-05-15, 529 objects, 293 MB) holds the
pre-CFLab LabBox backups: a consistent SQLite backup plus `/config`, `/data/minio`,
and compose files, described in [DATA-MIGRATION.md](DATA-MIGRATION.md) as
"archive/recovery source — presently encrypted/unavailable" (an encrypted Restic
repository).

Classification, pending object-level inspection (which needs S3 credentials):

| Question | Current answer |
| --- | --- |
| Backup date | Bucket created 2026-05-15; objects are from the LabBox era (before the 2026-09-20 cutover). |
| Source system | The retired LabBox VM (`lab.aismallbizguru.com`). |
| Type | Restic-encrypted archive plus SQLite/MinIO/config artifacts. |
| Size | 293 MB across 529 objects. |
| Likely usefulness | Unknown until the Restic repository is unlocked and its contents are listed. It is the only pre-cutover historical copy. |
| Equivalent copy elsewhere | **No.** CFLab's backups cover the migrated data from 2026-09-18 onward; they do not contain pre-migration LabBox history, deleted legacy rows, or non-migrated datasets. |

**Recommendation:** keep the bucket unchanged for now. Do not treat it as
redundant, and do not delete anything until all of the following hold: (1) the new
CFLab backups have run for at least 30 days with green freshness reports; (2) a
remote restore drill has succeeded; (3) the Restic repository has been unlocked
and inventoried; (4) an explicit decision records which LabBox datasets are not
represented in CFLab. Only then is a retention decision defensible — and it is a
separate, deliberate task, not a side effect of this phase.

## 9. Monitoring

| Signal | Where | Failure mode |
| --- | --- | --- |
| Backup freshness (≤ 30 h) | `backup-status.mjs` in the daily workflow | red workflow run; the report names the stale database and its age |
| Restore proof on every run | `restore-verify.mjs` step | the run stops before uploading, so a broken export never becomes a stored backup |
| Integrity of stored artifacts | manifest SHA-256 checked on download and on verification | `download-backup.mjs` refuses a mismatch |
| Mirror integrity | `--verify --sample 25` each run, `--verify` for everything on demand | red workflow run listing the offending keys |
| Production revision drift | `drift.yml` (daily) | red workflow run |
| Release health | `verify-production.mjs` after each deploy | red workflow run |

Read-only status at any time:

```sh
CFLAB_BACKUP_BUCKET=cflab-backups R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… CLOUDFLARE_ACCOUNT_ID=b1aa310aa0a1638d72b8b086a21e557c \
  node scripts/backup/backup-status.mjs --json
```

## 10. Status and what still needs approval

Implemented, committed, and tested:

* `scripts/backup/{lib,d1-export,restore-verify,upload-backups,download-backup,backup-status,r2-mirror,r2-client,verify-setup}.mjs`
* `.github/workflows/backup.yml` (daily + manual, gated by `CFLAB_BACKUPS_ENABLED`)
* `.github/workflows/restore-drill.yml` (manual; `mode=prepare` creates nothing,
  `mode=execute` needs `confirm=RESTORE-DRILL`)
* `test/backup/*.test.mjs` (29 tests: SigV4 vector, export verification, manifest
  integrity, freshness, mirror planning/verification, setup-policy evaluation,
  credential guards, the read-only production client, and the production-target
  refusal)

### Verified 2026-10-16 (Phase 4B)

| Check | Result |
| --- | --- |
| Backup bucket `cflab-backups` | **created 2026-10-16T14:32:25.025Z**, account `b1aa310aa0a1638d72b8b086a21e557c`, location `ENAM`, storage class Standard, **0 objects / 0 B** |
| Bucket lock rules | `protect-d1-backups` (`d1/`, `Age` 2,592,000 s = 30 days) and `protect-file-mirror` (`files/`, 30 days), both enabled, read back from the API |
| Lifecycle rules | `expire-d1-backups` (`d1/`, `maxAge` 7,776,000 s = 90 days), `expire-file-mirror` (`files/`, 34,560,000 s = 400 days), plus the preserved `Default Multipart Abort Rule` (7 days) |
| Public access | **disabled**: r2.dev URL disabled, no custom domains |
| `node scripts/backup/verify-setup.mjs` | every configuration check passes; the credential checks correctly report that no R2 credentials are present in this environment |
| GitHub backup credentials | still to create: `CFLAB_BACKUP_D1_TOKEN`, the R2 S3 keys, `CFLAB_RESTORE_D1_TOKEN`, and the `CFLAB_BACKUP_BUCKET` / `CFLAB_BACKUPS_ENABLED` variables |
| Production R2 (unchanged) | `cflab-files`: 1,329 objects, 267 MB; the `files` table records 1,325 rows / 266,972,411 bytes, so **4 objects are not represented in the table** — enumerating them needs S3 credentials, which do not exist yet |
| Real D1 export + isolated restore (repeated) | `cflab` 11,269,440 bytes / sha256 `6b5a87aa…` / 12 tables / 2,746 rows; `cflab-analytics` 696,164 bytes / sha256 `3c287493…` / 16 tables / 1,268 rows; both restored with `quick_check=ok`, no foreign-key violations, restore 10.7 s and 5.0 s |

Two operational lessons from provisioning, now encoded in the tooling and in §5.1:
`wrangler r2 bucket lock add` / `lifecycle add` **replace** the whole
configuration instead of appending (use `set` with the complete rule list — the
first attempt lost one rule from each list and the API read-back caught it), and
`lock list` / `lifecycle list` print key/value blocks rather than JSON, so
`verify-setup.mjs` parses that output and a test pins the real format.

### Automation boundaries (established 2026-10-16, with evidence)

| Action | Can it be automated? | Evidence |
| --- | --- | --- |
| Create the backup bucket, lock rules, lifecycle rules | **Yes — done** | `wrangler r2 bucket create` + `lock set` / `lifecycle set` with the operator's OAuth login |
| Read the bucket configuration | **Yes** | `r2 bucket info` / `lock list` / `lifecycle list` / `dev-url get` / `domain list`, and the REST API |
| Create Cloudflare API tokens (D1 read, D1 edit) and R2 API tokens | **No** — needs the dashboard | `GET /accounts/{id}/tokens` → `HTTP 403`, code `9109 Unauthorized to access requested resource`; the OAuth grant has no token-management scope (`wrangler whoami` scopes) |
| Set GitHub secrets | **No** — needs the dashboard | no `GH_TOKEN`/`GITHUB_TOKEN`, no `gh` config, no credential helper: the only GitHub access is SSH for `git push`, which cannot write secrets (and sealing a secret needs libsodium, which is not a dependency) |
| Set GitHub repository variables, dispatch a workflow | **No** — same reason | as above |
| Run the import/export/upload/status pipeline itself | **Yes**, once credentials exist in the environment | the four commands in §5.3 step 4 |

So the minimum operator action is exactly: create four credentials in the
Cloudflare dashboard (§5.2) and paste six secrets plus two variables into the
GitHub repository settings (§5.3 steps 1–2). Everything else — verification, the
first backup, freshness reporting, the mirror, and the drill — is already
implemented and can be run without touching a dashboard.

### Blockers to activation, in order

1. **Create `cflab-backups`** with the lock and lifecycle rules in §5.1. This is
   the one prerequisite only the account owner can perform.
2. **Create the three credentials** (§5.2) and add them as GitHub secrets plus the
   `CFLAB_BACKUP_BUCKET` variable. Without them the workflow's first step fails
   loudly instead of silently skipping.
3. **Run `node scripts/backup/verify-setup.mjs`** — it must print `PASS` before
   anything is scheduled.
4. **Run `production backups` manually once**, then set
   `CFLAB_BACKUPS_ENABLED=true` for the daily schedule.
5. **Authorize the remote drill** (`restore drill` → `mode=execute`,
   `confirm=RESTORE-DRILL`), which creates temporary billable databases that the
   run then tells you how to delete. `mode=prepare` needs no authorization and
   creates nothing.
6. **Decide on off-account retention** (not implemented here).
7. **A later, separate decision about the legacy LabBox archives** (§8).

Until 1–4 are done, no backup runs and production is protected only by Time
Travel, exactly as before this phase; `cflab-files` has no protection against an
accidental delete or overwrite.





