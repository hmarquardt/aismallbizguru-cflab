# Backup, retention, and recovery

CFLab's storage configuration covers three D1 databases (`cflab`, `cflab-analytics`,
and the provisioned, not-yet-migrated `cflab-bitcoin-signals`) and one private R2 bucket (`cflab-files`). This document is the inventory, the design, the
retention policy, the credential setup, and the recovery procedures. The release
runbook is [CI-CD.md](CI-CD.md); the policy agents must follow is
[AGENTS.md](../AGENTS.md).

**Principle: a backup is not operational until a restore has been demonstrated.**
Every scheduled run therefore restores each export into an isolated database and
compares it with its manifest *before* uploading anything
(`scripts/backup/restore-verify.mjs`). The third database gets the same treatment
as the first two: the export, manifest, freshness check, isolated restore, and
drill all cover the third database. Export and restore use `DATABASES` in
`scripts/backup/d1-export.mjs`; the freshness report and drill workflow explicitly
list the same three names. Database IDs and restore protection derive from the
production Wrangler configuration.

## 1. Inventory (primary/Analytics verified 2026-10-16; Signals provisioned 2026-10-25)

Verified facts were read from the live account with read-only commands
(`wrangler d1 info`, `wrangler d1 execute … SELECT`, `wrangler r2 bucket info`,
`wrangler d1 time-travel info`, `wrangler d1 export`).

### D1 databases

| Database | Id | Size | Tables | Rows | Created |
| --- | --- | --- | --- | --- | --- |
| `cflab` (`DB`) | `cb2d2eb4-2817-4581-8e50-d69212650adf` | 12 MB | 12 | 2,746 (4 apps, 1,336 records, 1,325 files, 2 users, 16 sessions, 10 migrations, 44 safari projection rows) | 2026-09-18 |
| `cflab-analytics` (`ANALYTICS`) | `54e8af8e-3345-40e7-88fd-462a688421b5` | 692 kB | 16 | 1,268 (387 analytics events, 297 pageviews, 131 sessions, 53 visitors, 3 sites, plus daily aggregates) | 2026-09-18 |
| `cflab-bitcoin-signals` (`BTC_SIGNALS`) | `7630355d-eae7-4410-aef5-7a0486ddc523` | 12,288 bytes | **0: production migration pending** | 0 | 2026-10-25 20:13:12 UTC (authorized creation) |

Export size measured on 2026-10-16: `cflab` 11,269,440 bytes, `cflab-analytics`
696,164 bytes. Both are in `ENAM`, storage version `production` (Time Travel
supported; the legacy snapshot API does not apply). The third database is included
in the tooling now, and its first verified export happens on the first backup run
after provisioning (`docs/BITCOIN-SIGNALS.md#9-provisioning`). The read-only freshness check on 2026-10-25 reports its backup as `missing`
while the first two databases have fresh backups. The new database has zero tables
and cannot yet supply a meaningful schema/data backup. The existing backup
gate was already `true` at the 2026-10-25 audit and must remain as found; migrate the third database through the authorized pipeline before relying on
its backup workflow coverage, then verify the first full backup/restore.

The independent audit also made snapshot export fail closed when the single
request cannot be read, added schema-definition hashes to new manifests, made a
failed restore verification fail the CLI, and checked the actual database ID behind
a remote restore alias. No production data or stored backup was modified.

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

* **Time Travel** was available on every existing database and is the only point-in-time
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

**Selected: GitHub Actions (scheduled, credential-gated) using a read-only
single-transaction logical dump for the databases and a small dependency-free S3
client for R2.**

| Decision | Why |
| --- | --- |
| GitHub Actions over a Worker Cron Trigger | A Worker cannot reach D1's import/export endpoints without embedding a Cloudflare API token in the Worker, and R2 object listing/copying is S3-only. GitHub Actions already owns releases, keeps the scripts versioned, needs no always-on compute, and gives per-run logs and failure reporting. |
| A read-only `SELECT` dump over the export API | The export API is consistent (it reports `at_bookmark`) but requires **D1 Write**, which would give the backup job write access to production. Reading every table inside one request gives the same single-transaction consistency with a **D1 Read** credential, and is 5× faster here (§7.3). `--method export` remains for an operator who holds a write-capable token. |
| Logical dumps over Time Travel alone | Time Travel is in-database and bounded (30 days paid / 7 days free). An independent artifact in a separate bucket survives a database deletion, a bad migration, or a compromised production credential. |
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
| Bad migration | to just before the migration (record the bookmark first, §6.3) | < 15 min |
| Database corruption or loss | ≤ 24 h (daily logical backup) | **measured: 2 m 14 s** to restore the two original databases into new D1 databases and verify them (§7.1); the third database follows the same isolated procedure |
| Accidental object deletion or replacement | ≤ 24 h (mirror run), any earlier version preserved | seconds to recover one object from the mirror (§7.4) |
| Full loss of the Cloudflare account | ≤ 24 h, and only if the backup bucket is exported off-account | hours — out of scope, documented as a limitation (§6.4) |

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

1. `d1-export.mjs` — read-only introspection, then a **read-only logical dump** of
   all three databases: the schema from `sqlite_schema`, every row of every table, and
   `sqlite_sequence`, all through `SELECT`, so the backup credential only ever needs
   **D1 Read**. Two properties make the dump restorable and consistent:
   * **One request, one transaction.** Every table is read inside a single request.
     D1 executes the statements of one request in one transaction, so the reads share
     a snapshot. Separate requests do not: measured on a temporary database under
     concurrent two-table commits, per-request reads tore 84% of the time and
     single-request reads never did (§7.3). The manifest records
     `consistency: single-request-snapshot`; if the single request ever fails, the
     fallback to per-table reads is recorded as `per-table-reads-not-a-snapshot`.
   * **Foreign-key ordered.** Tables are created and populated parents-before-children,
     taken from the live `REFERENCES` clauses, so the file imports in auto-commit mode
     — D1's import endpoint and the `sqlite3` shell included. This is not theoretical:
     an alphabetical dump failed every remote restore until it was fixed (§7.2).
   `wrangler d1 export` is deliberately *not* the default: the export API requires
   **D1 Write**, which would mean giving the backup job write access to production
   data. `--method export` still uses it for an operator who holds such a token.
2. `restore-verify.mjs` — restores each dump into an isolated local D1, then
   compares tables, row counts, `PRAGMA quick_check`, `PRAGMA foreign_key_check`,
   and **a canonical per-table row hash recorded in the manifest**. That last check
   proves the restore reproduces the backed-up data exactly, ordering aside.
   **An export that does not restore is never uploaded.**
3. `upload-backups.mjs` — uploads the verified artifacts with date-stamped keys.
   The client refuses to overwrite an existing object and refuses to write into
   `cflab-files` or the legacy LabBox backup bucket.
4. `backup-status.mjs` — fails the run when either database has no backup younger
   than 30 hours.
5. The `files` job mirrors production objects with `r2-mirror.mjs --apply
   --limit 2000 --concurrency 8` and verifies a 25-object sample. Eight objects are
   copied at a time (sequential copying of 1,329 objects took ~37 minutes;
   concurrency brings the same work under 4). Reads retry transient 5xx/429/network
   failures; writes never retry, so a failed write fails the run and the next run
   resumes. **Run only one mirror at a time** — a second concurrent run is refused
   as an overwrite rather than silently racing.

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

### 5.2 Credentials (provisioned 2026-10-16, four with separate authority)

| GitHub secret / variable | Kind | Permissions | Used by |
| --- | --- | --- | --- |
| `CFLAB_BACKUP_D1_TOKEN` | Cloudflare API token `cflab-backup-d1-read` | **D1: Read** on the account (no write) | `backup.yml` dump step |
| `CFLAB_BACKUP_SOURCE_R2_ACCESS_KEY_ID` / `…_SECRET_ACCESS_KEY` | R2 API token `cflab-backup-r2-source-read` | **Object Read**, scoped to `cflab-files` only | production reads in the mirror |
| `CFLAB_BACKUP_R2_ACCESS_KEY_ID` / `…_SECRET_ACCESS_KEY` | R2 API token `cflab-backup-r2-destination` | **Object Read & Write**, scoped to `cflab-backups` only | upload, status, mirror destination, restore reads |
| `CFLAB_RESTORE_D1_TOKEN` | Cloudflare API token `cflab-restore-d1-write` | **D1: Write** (the dashboard's "D1: Edit"; needed only to create the temporary drill database) | `restore-drill.yml`, manual restores |
| `CFLAB_BACKUP_BUCKET` | repository variable | `cflab-backups` | workflow configuration |
| `CFLAB_BACKUPS_ENABLED` | repository variable | `true` since 2026-10-16 | gates every backup job |

The four credentials were created through the Cloudflare API (`POST
/accounts/{account}/tokens`) with account token management, using permission groups
`D1 Read` (`192192df…`), `D1 Write` (`09b2857d…`), and the bucket-scoped `Workers R2
Storage Bucket Item Read`/`Write` (`6a018a9f…`, `2efd5506…`). Bucket scoping uses
the documented resource form
`com.cloudflare.edge.r2.bucket.<account_id>_default_<bucket_name>` — note the order:
`<account>_default_<bucket>`, not `<account>_<bucket>_default`. For an R2 API token
the S3 **Access Key ID is the token id** and the S3 **Secret Access Key is the
SHA-256 hash of the token value**, not the value itself (a raw value fails every
request with `SignatureDoesNotMatch`).

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

Both routes work; the API route above is what was actually used. Local runs can
source `~/.config/cflab/provisioned/env.sh` (mode 0600), which exports
`CLOUDFLARE_ACCOUNT_ID`, `CFLAB_BACKUP_BUCKET`, `CFLAB_FILES_BUCKET`, and the two R2
credential pairs derived from the token JSON in the same directory.

### 5.3 Activation record (2026-10-16)

Done, in this order:

1. **Four credentials created** through the API (§5.2) — D1 Read, D1 Write, R2
   Object Read on `cflab-files`, R2 Object Read & Write on `cflab-backups`.
   Scope was verified, not assumed: each R2 pair lists its own bucket and is
   **denied (HTTP 403)** on the other.
2. **Six secrets and two variables** stored in GitHub via `gh secret set` (values
   piped from files, never on a command line or in a log). `CFLAB_BACKUPS_ENABLED`
   started `false`.
3. **`verify-setup.mjs --probe-write` → `PASS`**: bucket present and private, both
   30-day locks, both lifecycle rules (90/400 days), production read, backup read,
   separate credential pairs, and the controlled write probe.
4. **First full backup and mirror**: both databases that existed then were dumped,
   restored, and verified by row hash, then uploaded; all 1,329 production objects
   (254.9 MB) mirrored and re-hashed end to end. `backup-status.mjs
   --max-age-hours 30` reported both fresh. The report now covers all three
   databases, so it stays red until `cflab-bitcoin-signals` is migrated and
   independently backed up and restored.
5. **`CFLAB_BACKUPS_ENABLED=true`**, then the `production backups` workflow was
   dispatched and completed **green** (run
   [38928586452](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/38928586452)),
   which is the proof that the scheduled configuration works with these secrets.
   The workflow is `active` and keeps its 03:37 UTC schedule.
6. **Restore drill: not run** — the remote drill is deliberately left for the
   operator (§6/§7), and production was never restored, no archive was deleted.

Two defects were found by running this against production and fixed: the D1 backup
credential had to stop depending on the write-only export API (§4 step 1), and
`writeJsonFile` did not create its parent directory, which broke the mirror step's
`--report` in CI.

**Residual operator action.** The temporary account-token-management credential used
for provisioning (a *user* token, id `ab307d5957761af58d64bdd5eecc4f8a`) **could not
be revoked through the API**: `DELETE /user/tokens/{id}` returned HTTP 403
(`code 9109`), because its grant covers account-token creation, not user-token
deletion. Its local copy (`~/.config/cflab/token-bootstrap`) has been removed with
`rm -P`, so the value is no longer on disk, but the token is still active and must
be deleted by hand: **Cloudflare dashboard → My Profile → API Tokens → find the
temporary token → Delete**. Until that is done, one credential with account token
management exists.



### 5.4 Re-provisioning from scratch (if the credentials are ever lost)

Everything below is required once; nothing runs until it is done. On a fresh
account, follow §5.1 first.

1. **Create the four credentials** (§5.2).
2. **Add them to GitHub** (Settings → Secrets and variables → Actions):
   * Secrets: `CFLAB_BACKUP_D1_TOKEN`, `CFLAB_BACKUP_SOURCE_R2_ACCESS_KEY_ID`,
     `CFLAB_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY`, `CFLAB_BACKUP_R2_ACCESS_KEY_ID`,
     `CFLAB_BACKUP_R2_SECRET_ACCESS_KEY`, `CFLAB_RESTORE_D1_TOKEN`.
   * Variables: `CFLAB_BACKUP_BUCKET=cflab-backups`, `CFLAB_BACKUPS_ENABLED=false`
     (set it to `true` again once step 4 is green — leaving it `false` while the
     credentials are wrong keeps a failing schedule quiet).
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
   with `confirm=RESTORE-DRILL` and `database=all` to restore **all three**
   databases into temporary databases, verify the result, and tear them down with
   the commands the run prints. Repeat quarterly, and once immediately after
   `cflab-bitcoin-signals` has been migrated through the pipeline so it has its own
   demonstrated restore before the schedule depends on it.

## 6. Recovery procedures

### 6.1 One database, from a logical backup

```sh
# 0. Credentials: reading the backup bucket needs the backup pair;
#    creating/restoring a temporary database needs CFLAB_RESTORE_D1_TOKEN (D1 Write).
export CFLAB_BACKUP_BUCKET=cflab-backups CLOUDFLARE_ACCOUNT_ID=b1aa310aa0a1638d72b8b086a21e557c
export R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…

# 1. Fetch the newest stored backup; the artifact's size and SHA-256 are checked
#    against its manifest before it is written locally.
node scripts/backup/download-backup.mjs --database cflab --out recovery

# 2. Restore it locally first (isolated SQLite, no cloud resources).
node scripts/backup/restore-verify.mjs --manifest recovery/cflab-*.manifest.json --work-dir recovery/drill

# 3. Prove it in a real D1 database: create a clearly named temporary one and restore
#    the artifact into it. This is the step that exercises the real import path.
export CLOUDFLARE_API_TOKEN=…   # CFLAB_RESTORE_D1_TOKEN
npx wrangler d1 create cflab-recovery-$(date -u +%Y%m%dT%H%M%SZ) --config wrangler.jsonc
#    Write a config that declares that temporary database (see the drill workflow for
#    the exact JSON), then:
node scripts/backup/restore-verify.mjs \
  --manifest recovery/cflab-<stamp>.manifest.json \
  --remote-database cflab-recovery-<stamp> --remote-config recovery/cflab.config.json \
  --allow-remote-write
#    Tear it down when satisfied (only this database):
npx wrangler d1 delete cflab-recovery-<stamp> --config wrangler.jsonc --skip-confirmation
```

**Applying a backup to a database that already has data does not work as-is.** The
dump contains `CREATE TABLE` statements, so the production-writing shortcut

```sh
CLOUDFLARE_API_TOKEN=… npx wrangler d1 execute DB --remote --config wrangler.jsonc --file recovery/cflab-<stamp>.sql -y
```

only applies to an **empty** database — which is exactly the disaster case it is for
(new database, then repoint the `DB` binding). Choose the path that matches the
situation:

| Situation | Path |
| --- | --- |
| A row was changed or deleted by mistake | Time Travel restore to just before the change (§6.3) — in place, no export needed, 30-day window |
| A handful of rows must be restored into a live database | Extract those rows from the dump and apply them as `UPDATE` / `INSERT OR REPLACE` statements; do not run the whole file |
| The database is corrupt, deleted, or lost | Create a new D1 database, import the dump into it (the drill's step 3), then move the binding to it |
| The whole account is lost | Out of scope (§6.4) |


# 3. Restore into production only when that is the deliberate decision
CLOUDFLARE_API_TOKEN=… npx wrangler d1 execute DB --remote --config wrangler.jsonc --file recovery/cflab-<stamp>.sql -y
```

Step 3 is the only production-writing command in this document. It replaces rows
in place; it does not drop the schema. For a partial recovery, extract the needed
`INSERT` statements from the SQL file and run those instead of the whole file.

### 6.2 A single object (deleted or replaced)

`r2-recover.mjs` reads the mirror, lists every version it holds for a key, downloads
the one you choose into an isolated directory, and verifies the bytes against the
content address they were stored under. It is read-only on both buckets.

```sh
# What does the mirror hold for this key? (versions, sizes, timestamps)
export CFLAB_BACKUP_BUCKET=cflab-backups CLOUDFLARE_ACCOUNT_ID=b1aa310aa0a1638d72b8b086a21e557c
export R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…              # backup bucket
export R2_SOURCE_ACCESS_KEY_ID=… R2_SOURCE_SECRET_ACCESS_KEY=… # production, read-only
node scripts/backup/r2-recover.mjs --list apps/wildlife-field-recorder/files/<id>

# Which keys have more than one version (i.e. were replaced while mirrored)?
node scripts/backup/r2-recover.mjs --list-duplicates

# Recover the newest version, or a specific superseded one, into an isolated directory
node scripts/backup/r2-recover.mjs --key apps/.../files/<id> --out /tmp/recovery --report /tmp/recovery.json
node scripts/backup/r2-recover.mjs --key apps/.../files/<id> --sha256 <older digest> --out /tmp/recovery
```

The command prints whether the recovered bytes match the current production object,
so "the mirror still has the version that was replaced" is a check, not a hope.
Putting it back is the deliberate step:

```sh
npx wrangler r2 object put cflab-files/apps/.../files/<id> --file /tmp/recovery/apps/.../files/<id> --force
```

Without an S3 client, `wrangler r2 object get cflab-backups/files/<sha256>/<key> --file <path>`
followed by the `object put` above also works. Restoring one object never touches a
database; a `files` row for a file that no database references is restored separately
(§6.1).

### 6.3 Point-in-time recovery (no backup needed)

For an accidental `UPDATE`/`DELETE` or a bad migration, this is the fastest and most
precise path: it restores the whole database in place to a moment you choose, without
an export. It works on the last 30 days (Workers Paid) / 7 days (Free).

```sh
# 1. Record the CURRENT bookmark first: it is the undo point if the restore is wrong.
npx wrangler d1 time-travel info DB --config wrangler.jsonc

# 2. Restore to the moment just before the mistake (Unix timestamp or bookmark).
npx wrangler d1 time-travel restore DB --config wrangler.jsonc --timestamp=<unix seconds>
npx wrangler d1 time-travel restore DB --config wrangler.jsonc --bookmark=<bookmark>
```

This is destructive in place and cancels in-flight queries: the command prints the
previous bookmark, which is how you undo it. Two practical notes:

* `time-travel info` is not available to the read-only backup credential (it needs
  write access), so an operator must use the D1 Write credential or the dashboard.
  The backup manifests record `bookmark_before`/`bookmark_after` whenever the running
  credential can read them, which is a hint about *when* a backup corresponds to —
  useful context, not a substitute for the restore point you choose here.
* Restoring cancels in-flight queries, so expect a short error window for the
  application. See [CI-CD.md → D1 recovery](CI-CD.md#d1-recovery).

### 6.4 Limitations (honest list)

* **Consistency.** A dump is a consistent read of the committed state at one instant,
  because every table is read in a single request (one transaction). It is not a
  frozen snapshot of the database while the read runs, and it does not include writes
  that commit after the read begins: RPO is the read, not an earlier moment. If the
  single request ever fails and the per-table fallback runs, the manifest says so
  (`consistency: per-table-reads-not-a-snapshot`), and such a backup can mix commits
  across tables.
* **Restores replace, they do not merge.** A restore does not roll back schema, and
  the dump's `CREATE TABLE` statements mean it applies cleanly only to an empty
  database (§6.1).
* **Time Travel is the only in-place, point-in-time mechanism**, and it is bounded by
  30 days. The logical backups are the independent copy that survives deleting the
  database or losing Time Travel's window.
* **The mirror preserves object bytes, not `files` table rows.** Restoring a file the
  database no longer references needs a matching database restore or a manual row
  insert.
* **No replaced object has occurred yet.** The mirror holds exactly one version for
  each of the 1,329 production keys, so the superseded-version path is unit-tested and
  the byte-identical recovery path is drilled (§7.4), but a real replacement has not
  yet had to be recovered. After the first replacement, `r2-recover.mjs
  --list-duplicates` will show the key.
* **Both copies live in the same Cloudflare account.** Account-level loss (or loss of
  the credentials) is not covered. Exporting the backup bucket off-account
  periodically is a documented follow-up, not something this phase implements.
* `PRAGMA integrity_check` and `PRAGMA user_version` are not authorized in D1; the
  verification uses `quick_check` and `foreign_key_check`, plus per-table row hashes.
* The backup credentials cannot read Time Travel bookmarks, and the backup token
  cannot export through Cloudflare's export API (that needs D1 Write). Both are
  deliberate consequences of keeping the backup job read-only.

### 6.5 Disaster recovery checklist

Print this and keep it with the credentials. Every command is in §6; nothing here is
destructive except the two steps marked ⚠.

1. **Identify the loss.** Which of: a database, a set of rows, one file object, many
   objects, the whole account? (Wrong answer here wastes the most time.)
2. **Freeze the damage.** Stop the writers that caused it (deploy rollback or a
   maintenance switch). Note the current time in UTC.
3. **Check the cheap path first.** For recent row damage, `d1 time-travel info` on the
   affected database and restore to just before the incident (§6.3). Record the
   previous bookmark from the output before confirming.
4. **Confirm backups exist and are fresh** (read-only, backup credentials):
   `node scripts/backup/backup-status.mjs --max-age-hours 30 --json`.
5. **Fetch and verify the artifact** (§6.1 step 1); the download refuses a manifest
   mismatch.
6. **Prove it in isolation** before touching production: local restore, then a
   temporary D1 database (§6.1 steps 2–3). Compare tables, row counts, row hashes,
   `quick_check`, and foreign keys.
7. ⚠ **Apply**: for a lost database, import into a new one and repoint the binding; for
   selected rows, apply extracted statements; for a file object, `r2-recover.mjs` then
   the deliberate `r2 object put` (§6.2).
8. **Verify from the outside**: hit the application, not just SQL — the release
   verifier (`verify-production.mjs`) plus one real user flow.
9. **Delete nothing but your temporary resources** (§6.1 teardown), and keep the
   evidence: manifests, restore reports, and the timings.
10. **Write down the new baseline**: the incident time, the recovery point used, and
    the measured duration, so the next drill compares against a real number.

## 7. Restoration drill results

### 7.1 Remote restore into temporary D1 databases (2026-10-16, Phase 5)

The `restore drill` workflow (`mode=execute`, `confirm=RESTORE-DRILL`, `database=both`)
ran against the stored backups. It created two clearly named temporary databases,
downloaded and verified both artifacts, restored each into its temporary database
through the real D1 import path, verified the result, and printed the teardown
commands. The run was **green**: [38937976131](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/38937976131).

| Check | `cflab` | `cflab-analytics` |
| --- | --- | --- |
| Backup restored | 11,269,397 bytes, `20261016T170903Z` | 697,167 bytes, `20261016T170903Z` |
| Temporary database | `cflab-restore-cflab-20261016T171425Z` | `cflab-restore-cflab-analytics-20261016T171425Z` |
| Tables | 12 of 12 ✔ | 16 of 16 ✔ |
| Rows vs manifest | 2,746, all tables equal ✔ | 1,273, all tables equal ✔ |
| Per-table canonical row hashes vs manifest | 0 mismatches ✔ | 0 mismatches ✔ |
| `PRAGMA quick_check` | `ok` ✔ | `ok` ✔ |
| `PRAGMA foreign_key_check` | 0 violations ✔ | 0 violations ✔ |
| Representative application row (newest `files` row: id, object key, 61,067 bytes, checksum) | identical to production ✔ | analytics rows present ✔ |
| Migration ledger and `sqlite_sequence` | 10 migrations, sequence restored ✔ | — |

Verification was repeated **independently after the workflow finished** (the same
queries run by hand, comparing every table's row hash against the stored manifest,
plus the representative row against live production): 0 mismatched tables in both
databases.

**Isolation.** The restored data lived only in the two temporary databases. Every
command names its target explicitly, and `restore-verify.mjs` refuses production names
and ids outright (`assertNotProductionTarget`). Production was only ever read — its row
counts, `files` total, and checksums are unchanged. Both temporary databases were
deleted after verification (`wrangler d1 delete <temp> --skip-confirmation`), after
which `wrangler d1 list` showed only `cflab` and `cflab-analytics`.

**Measured duration (practical RTO).**

| Phase | Duration |
| --- | --- |
| Whole drill job, both databases that existed on 2026-10-16, end to end (download, both local restores, both temporary databases, both remote restores, both verifications, evidence upload) | **2 m 14 s** |
| The same drill with `database=all` now covers three databases; the added restore is proportionally small and should be re-measured on the first three-database drill | to be measured |
| Import into a real D1 database (`restore_ms` in the report) | ~10 s per database |
| Verification including all per-table row hashes (`verify_ms`) | ~15–25 s per database |
| Isolated local restore (runs on every daily backup) | 8.2 s (`cflab`), ~4 s (analytics) |

Restoring a database into a new D1 database and proving it is a **~2 minute**
operation at this volume; the dominant costs are checkout, `npm ci`, and the two
database creations, not the 12 MB of data.

### 7.2 What the drill caught (run `38936259705`, failed)

The first attempt **failed**, and the failure was real:

```
✘ ERROR {"D1_RESET_DO":true}
```

The dump inserted tables alphabetically, so `password_reset_tokens` was inserted before
its parent `users`. The local restore passed because `PRAGMA defer_foreign_keys` held
the check until the end of the transaction; D1's import path runs statements in
auto-commit, so the foreign key failed, the import was rejected, and D1 reported it as
the opaque `D1_RESET_DO`. Reproduced deterministically against a fresh database, then
bisected with a chunked import through the query API (which reports real errors) down
to the offending statement:

```
FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)
INSERT INTO "password_reset_tokens" (...) VALUES(...)
```

Fix: order the dump parents-before-children from the live `REFERENCES` clauses, with
per-table create-then-insert groups (§4), and dump `sqlite_sequence` last. A reference
cycle is refused rather than emitted as an unorderable file. After the fix the same
import reported `num_tables: 12` and the drill passed. **A backup that had never been
restored into a real D1 database had been silently un-restorable.**

### 7.3 Consistency experiment (2026-10-16)

Question: can reading each table with its own `SELECT` produce an inconsistent backup
while the application writes?

Method: a temporary D1 database (created and deleted by the probe) with two tables and
a trigger that increments `b.v` whenever `a.v` is incremented **inside the same
statement**, so every commit leaves `a.v == b.v`. A writer loop committed those updates
continuously; three read strategies sampled the invariant.

| Read strategy | Samples | Inconsistent | Tear rate |
| --- | --- | --- | --- |
| Per-table SELECTs, one request each (the previous implementation) | 100 | **84** | **84.0%** |
| All tables in one request (the current implementation) | 100 | 0 | **0.0%** |
| One statement reading both tables | 100 | 0 | 0.0% |

345 writer commits landed during the run, so the writer was genuinely concurrent.

The old per-table read was **not** consistent: 84% of backups taken under write load
could have mixed commits across tables. Reading every table in a single request is
consistent because D1 executes the statements of one request in one transaction, and it
is also ~5× faster (2.5 s versus 14.6 s for 12 tables). The daily backup now does the
latter and records `consistency: single-request-snapshot` in the manifest, so a future
change cannot quietly revert it.

Not chosen, with reasons: Cloudflare's **export API** is consistent (its response
carries `at_bookmark`) but requires **D1 Write**, which would give the backup job write
access to production — the opposite of the least-privilege design. **Time Travel
bookmarks** provide point-in-time recovery but no read-at-bookmark path (and no
`fork`/`copy` subcommand in wrangler 4.135), and the read-only backup credential cannot
read bookmarks at all. Both remain available to an operator by hand (§6.3).

### 7.4 R2 file recovery (2026-10-16)

Representative production objects were recovered from the mirror through
`r2-recover.mjs` — the documented path — into an isolated directory, then compared
byte-for-byte with the current production object.

| Object | Size | Result |
| --- | --- | --- |
| smallest object in the bucket | 4 B | byte-identical ✔ |
| largest object in the bucket | 9,710,000 B | byte-identical ✔ |
| one object per application prefix (`apps/wildlife-field-recorder`) | 1,126,824 B | byte-identical ✔ |
| one object per application prefix (`apps/top-hat-ferals`) | 113,279 B | byte-identical ✔ |

Every recovered object's SHA-256 matched both the mirror's content address and the
production object: 4 recovered, 4 identical, 0 mismatched. Nothing was written to
production and nothing was deleted from either bucket.

**Replaced-version recovery has not yet been exercised on a real replacement**, because
none has happened: the mirror holds exactly one version for each of the 1,329
production keys, and `--list-duplicates` reports 0 keys with history. The path is
implemented and unit-tested (a key with two versions lists both, the superseded one is
selectable by `--sha256`, and a key deleted from production still reports every version
as recoverable), and the drill above exercises the download-and-verify half. The first
real replacement will appear in `r2-recover.mjs --list-duplicates`.

### 7.5 Earlier local restore evidence (2026-10-16, Phase 4)

Both databases were also restored into **isolated local D1 databases**
(`--persist-to` into a private state directory) — a real restore of real production
data into a real SQLite database, repeated on every daily backup.

| Check | `cflab` | `cflab-analytics` |
| --- | --- | --- |
| Artifact size / SHA-256 verified against the manifest | 11,269,320 bytes ✔ | 697,095 bytes ✔ |
| Tables restored | 12 of 12 ✔ | 16 of 16 ✔ |
| Row counts, `quick_check`, `foreign_key_check`, row hashes | all equal, `ok`, 0 violations ✔ | all equal, `ok`, 0 violations ✔ |
| `files` total restored | 266,971,818 bytes, identical to the live database ✔ | — |

`Time Travel restore` was deliberately **not** exercised: it is destructive in place
against a live database and is documented as an operator action only (§6.3).


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
| Backup freshness (≤ 30 h) | `backup-status.mjs` in the daily workflow, covering `cflab`, `cflab-analytics`, and `cflab-bitcoin-signals` | red workflow run; the report names the stale or missing database and its age |
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

* `scripts/backup/{lib,d1-export,restore-verify,upload-backups,download-backup,backup-status,r2-mirror,r2-client,r2-recover,verify-setup}.mjs`
* `.github/workflows/backup.yml` (daily + manual, gated by `CFLAB_BACKUPS_ENABLED`)
* `.github/workflows/restore-drill.yml` (manual; `mode=prepare` creates nothing,
  `mode=execute` needs `confirm=RESTORE-DRILL`, and the evidence is uploaded as a
  90-day artifact)
* `test/backup/*.test.mjs` (**46 tests**: SigV4 vector, export verification, manifest
  integrity, foreign-key dump ordering, sequence restoration, freshness, mirror
  planning/verification, mirror recovery and superseded-version selection,
  setup-policy evaluation, credential guards, the read-only production client, and the
  production-target refusal)

### State after Phase 5 (2026-10-16)

Backups are **active and verified**: the daily workflow runs green, the mirror holds
all 1,329 production objects, a remote restore of both databases into temporary D1
databases succeeded and was verified row-by-row, and representative file objects were
recovered byte-identically (§7). The credentials, activation record, and the one
outstanding operator action (deleting the temporary provisioning token by hand) are in
§5.3. Still open, in priority order:

1. **Delete the temporary account token-management credential in the dashboard**
   (§5.3) — the only outstanding security action.
2. **Decide on off-account retention** of the backup bucket (§6.4) — the account-level
   loss case is not covered.
3. **A later, separate decision about the legacy LabBox archives** (§8).
4. **Re-run the drill quarterly**, and after any change to the backup or restore code,
   so "verified" keeps meaning verified.


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

**Superseded in part:** this table records what was possible before the `gh` CLI
credential was installed. Secrets and variables are now written from the command line
(`gh secret set` / `gh variable set`) and workflows are dispatched with `gh workflow
run`; token creation through the Cloudflare API became possible with a
token-management credential that is itself being retired (§5.3).

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

### Blockers to activation, in order (all resolved on 2026-10-16 — kept for the record)

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






## CoinGecko conditional retention exception

On 2026-10-25 the operator authorized restoring CoinGecko treasury research with
the narrow exception recorded in [AGENTS.md](../AGENTS.md). Normal backups remain
append-only and verified; no deletion capability is added to the backup client.
If API access is terminated and deletion is required, disable the provider and
inventory all retained CoinGecko copies, including observations, derived outputs,
exports, local drills and D1 backup artifacts. Prepare verified clean replacements
that preserve every unrelated row and table before requesting the operator's
specific approval for production remediation. Manifests/attestations for replaced
artifacts must be corrected, not left reporting missing originals as restorable.

The current 30-day R2 locks are configurable, rather than an irrevocable legal hold;
[Cloudflare documents removing/updating lock rules](https://developers.cloudflare.com/r2/buckets/bucket-locks/).
Do not remove a broad protection rule as a shortcut. A remediation plan must keep
protection for unrelated objects and restore the normal protection/freshness
checks after the scoped operation. No lock, bucket object, credential, production
row or existing backup was modified to enable collection in the working tree.
Paid CoinGecko access alone would not waive its termination-deletion condition.
