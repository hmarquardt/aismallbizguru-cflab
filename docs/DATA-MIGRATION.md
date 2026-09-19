# CFLab data migration

CFLab has two migration sources. They serve different purposes and must not be confused:

```text
CURRENT OPERATIONAL MIGRATION
  live LabBox read API (GET only)     -> current application baseline

ARCHIVAL / HISTORICAL RECOVERY
  encrypted Restic repository in R2   -> later forensic/recovery source (not available yet)
```

The operational baseline is complete and reconciled. The Restic archive remains untouched and is not a prerequisite for client pilots.

## Source endpoints (GET only)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/apps` | public | app registry and read policy |
| `GET /api/wildlife-field-recorder/observations` | app read token | wildlife observations |
| `GET /api/wildlife-field-recorder/trips` | app read token | wildlife trips |
| `GET /api/top-hat-ferals/sightings` | public | Top Hat sightings |
| `GET /api/top-hat-ferals/cats` | public | Top Hat cats (empty) |
| `GET /api/top-hat-ferals/interactions` | public | Top Hat interactions (empty) |
| `GET /api/files/{id}` | owning app read access | file bytes |
| `GET /api/{app}/{resource}/{record}/files` | owning app read access | record file metadata (also embedded in record output) |

`GET /api/health` is deliberately never called: source inspection shows its storage check can create a MinIO bucket.

The exporter only issues GET requests and refuses any other method.

## Read authentication

Private wildlife data is exported with an existing read-only credential already present in the operator's Safari client (a public read-only map). The credential is passed to the tooling through `--token-file` outside version control and is never printed, logged, or committed. Public Top Hat data needs no credential.

Legacy bearer tokens are **not** imported into CFLab. CFLab's own machine tokens and human sessions remain authoritative; project memberships are provisioned through CFLab administration.

## Tooling

```sh
# 1. GET-only export -> private snapshot under .migration/ (gitignored)
node scripts/migrate/export-labbox.ts --out .migration/snapshots/<id> --token-file <path>

# 2. dry-run import (default; no mutation)
node scripts/migrate/import-cflab.ts --snapshot .migration/snapshots/<id>

# 3. apply to CFLab (D1 SQL batches + R2 REST uploads)
CF_API_TOKEN=... node scripts/migrate/import-cflab.ts --snapshot .migration/snapshots/<id> --execute

# 4. repair/verify R2 with rate-limit-aware throttling (idempotent)
R2_API_TOKEN=... node scripts/migrate/sync-r2.ts --snapshot .migration/snapshots/<id> --rps 3 --verify all

# 5. reconcile counts/bytes/relationships
node scripts/migrate/reconcile.ts --snapshot .migration/snapshots/<id>

# 6. delta between two snapshots
node scripts/migrate/reconcile.ts --snapshot <new> --compare <old>
```

`npm run test:migration` covers GET-only enforcement, complete-collection pagination, repeated-cursor and partial-fetch failures, credential redaction, validation, stable IDs, URL transforms, idempotence, conflicts, orphan detection, file hashing, and snapshot diffs.

## Snapshot layout (private)

```text
.migration/snapshots/<snapshot_id>/
  snapshot.json          records + files + manifest (private; never committed)
  manifest.json          counts, timestamps, app map
  records/all.json       raw records including file metadata
  files/meta.json        file metadata with record relationships
  files/objects/<id>     downloaded bytes
  files/hashes.json      SHA-256 per object
```

Snapshots contain GPS coordinates and sensitive wildlife data. `.migration/` is gitignored; never commit snapshots, bytes, or raw exports. Committed reports under `migration-reports/` are aggregate counts only.

## Transform policy

| Legacy concept | Destination | Treatment |
| --- | --- | --- |
| apps + origins | `apps`, `app_origins` | create only real consumers (`wildlife-field-recorder`, `top-hat-ferals`) with the current GitHub Pages origin |
| records (`data_json`) | `records` | preserve IDs, `created_at`, `updated_at`, payloads |
| legacy file URLs in `photo_url`/`photo`/`image` | rewritten to `/api/apps/{app}/files/{id}/content` | only when the file was migrated; counted as a transform |
| files | `files` + `cflab-files` R2 | preserve ID, filename, MIME type, size, SHA-256, timestamp; deterministic key `apps/{app}/files/{id}` |
| record/file relationship | `files.resource`, `files.record_id` (migration 0003) | additive nullable columns + index; no record-file table needed |
| soft-deleted records | not present | live API hides tombstones; documented limitation, recoverable later from Restic |
| machine tokens, human credentials | not copied | recreate through CFLab auth; never import legacy secrets |
| proxy sources | not copied | no live consumer found; migrate only if one appears |
| analytics | deferred | separate workstream; dashboard reads need an unavailable credential |
| events, jobs, backup_runs, registry/schema UI, creator-token fields | discarded | no consumer or operational value in CFLab |

## Safari public projection and curation

Hank & Heather's Wildlife Safari reads a public projection instead of the private wildlife app:

```text
GET /api/public/wildlife-safari/observations
GET /api/public/wildlife-safari/files/:id
```

Only records explicitly listed in `safari_public_records` are exposed, and responses are constructed from an allowlist: species, category, `observed_at`, count, description, normalized weather, a coarse approximate location (one decimal degree), and photo references. Exact GPS, transcripts, field notes, behavior/habitat, tags, raw payloads, file metadata, and R2 object keys are never returned. Photos are served only when the file is an image and its record is curated.

The initial allowlist was seeded from migrated observations that have at least one image file (44 records, 63 photos). This is an explicit, rerunnable rule; operators can curate further:

```sh
# seed (idempotent): photo-bearing observations
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "
INSERT OR IGNORE INTO safari_public_records (record_id, created_at)
SELECT DISTINCT f.record_id, datetime('now') FROM files f JOIN records r ON r.id = f.record_id
WHERE f.app_id='wildlife-field-recorder' AND f.content_type LIKE 'image/%' AND f.record_id IS NOT NULL;"

# add or remove a specific record
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "INSERT OR IGNORE INTO safari_public_records (record_id, created_at) VALUES ('<record-id>', datetime('now'));"
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "DELETE FROM safari_public_records WHERE record_id='<record-id>';"
```

The Safari client contains no credential. `npm run test:migration` includes a static assertion (when the sibling client checkout is present) that rejects `Authorization`/`Bearer`/`READONLY_TOKEN`, token-like literals, and any non-analytics LabBox API base.

## Baseline results (snapshot `20260919T012121Z`)

```text
exported:     1092 observations, 51 trips, 10 sightings (1153 records)
files:        1151 objects, 250,088,696 bytes, all SHA-256 verified at export
imported:     2 apps, 1153 records, 1151 files, 1151 record links, 0 conflicts/orphans
R2:           1151/1151 objects hash-verified after throttled sync
reconciliation: exact counts and bytes for every dataset
```

The first bulk upload pass hit the Cloudflare API rate limit (429) and a stale token (401); `sync-r2.ts` repaired the 758 missing objects with throttling/backoff and verified every object. CFLab auth state (admin user, session) was untouched.

## Delta strategy

The baseline is a point-in-time API snapshot (`snapshot_started_at`/`snapshot_completed_at`). Before client cutover, rerun the exporter and compare:

```sh
node scripts/migrate/export-labbox.ts --out .migration/snapshots/<new> --token-file <path>
node scripts/migrate/reconcile.ts --snapshot .migration/snapshots/<new> --compare .migration/snapshots/20260919T012121Z
```

The diff reports added/changed/disappeared records (by stable ID, `updated_at`, payload) and files (by ID, size, hash). No CDC or live replication is implemented.

## Archival Restic repository

```text
bucket:  labs-smallbizguru-backups
format:  Restic (encrypted)
objects: 521, ~279 MiB
snapshots: 129, oldest 2026-05-15, newest 2026-09-18T07:30:33Z
contents: consistent SQLite backup, /config, /data/minio, compose files
status:  archive/recovery source — presently encrypted/unavailable
```

It can later recover hidden soft-deleted records, internal metadata, and historical artifacts. Do not modify, prune, or unlock it, and do not treat it as a blocker.

## Intentional omissions

- No analytics import.
- No legacy token/credential import.
- No proxy-source import (no consumer).
- No soft-deleted tombstone recovery in this baseline.
- No client changes; Pattern Lab, Safari, Field Recorder, Top Hat, and Junk Drawer still use LabBox.
- No LabBox mutation: every request was GET; DNS and service unchanged.
