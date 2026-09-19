# LabBox migration

## Reference and status

The old source is available at `../aismallbizguru-lab`, repository `aismallbizguru-lab`. This pass inspected the working-tree code and recorded HEAD `b0f1bb5f33b9333ad4e2a0add2fb00aed9aa0d92`. No old files, resources, data, or DNS were changed. This is source-level comparison, not proof that the inspected tree matches the deployed version or every current client.

The source/client audit, pinned revisions, evidence, classifications, and detailed compatibility matrix are in [COMPATIBILITY.md](COMPATIBILITY.md). Confirmed clients are Wildlife Pattern Lab, Wildlife Field Recorder, Top Hat Ferals, and the analytics collector/dashboard. Source usage is not proof that the deployed revisions/configuration match these checkouts. No live checks or production exports have been performed.

## Compatibility matrix

| Area | Inspected LabBox | CFLab MVP / required work |
| --- | --- | --- |
| Health | `/api/health` (router mounted at `/api` in `main.py`), DB and optional storage checks, version/host fields | Same path, liveness only with `service: "cflab"`; adapt monitor response checks |
| Records | `/api/{app_id}/{resource}[/{record_id}]` | `/api/apps/{app}/resources/{resource}/records[/{id}]`; update clients or add tested adapter |
| Payload | `{data: {...}}`; PATCH replaces supplied data | Same envelope/replacement concept; data required on create, empty PATCH rejected; optional relational status |
| Lists | `{records, total}`, all records, newest first | Bounded `{records, next_cursor}`, UUID order; clients must paginate and cannot assume chronology |
| Deletion | Soft delete; `{status: "deleted"}` | Permanent deletion; HTTP 204; decide retention before migrating a client |
| Record output | Creator token ID, deleted timestamp, linked files, image fallback | Core fields and status only; explicit client file references needed |
| Resources | YAML registry; declared resources and required-field validation | Implicit namespaces, object payloads; no application schema enforcement |
| App config | YAML-derived public registry | Authenticated per-app JSON configuration in D1 |
| Auth | Tokens may span apps; app-level read/write or wildcard; some public reads | One app per token, explicit capability scopes, no public reads; issue new tokens |
| Token hashes | SHA-256 of opaque random token | SHA-256 but new `cfl_` format/scope semantics; do not blindly import token rows |
| Files | Multipart attached to a resource/record; `/api/files/{id}` download; deletes bytes then tombstones metadata, even on storage failure | Raw app-owned uploads; scoped relative content URL; physical delete; no native record relationship |
| Proxy | `/api/proxy/{slug}`; global sources, optional public access/redirects; cache and header schema fields not implemented in fetch | Per-app authenticated sources, no redirects/cache, strict operator host allowlist |
| Admin | Custom cookie/password/session routes/UI | Human email/password sessions with admin and project roles; no legacy session compatibility ([AUTH.md](AUTH.md)) |
| Special features | Wildlife trip aggregation, analytics, workers/jobs, backups | Analytics has confirmed consumers; specialized trip route has no found client caller; operational jobs/backup usage still unknown |
| Errors | FastAPI `detail` envelopes | `{error:{code,message}}`; update client error handling |

No automatic route aliases are installed. Compatibility-sensitive routing lives in `src/app.ts`; request/response shapes live in `src/routes/records.ts` and `files.ts`; token semantics live in `src/auth/tokens.ts`; proxy policy lives in `src/proxy/`. Add a small explicit compatibility router only after real consumer fixtures identify which translations are required. Do not reproduce any legacy cross-app authorization weaknesses while adapting routes.

## Parallel-run plan

1. Use the audited client inventory, then confirm the actual deployed LabBox/client revisions and any additional consumers/automation. Capture sanitized fixtures and real size/count inventories. Prefer small frontend adapters over guessing broad legacy compatibility.
2. **Milestone A:** publish CFLab independently at `https://cflab.aismallbizguru.com` using its own `cflab` Worker/D1 and `cflab-files` R2 bucket; follow [DEPLOYMENT.md](DEPLOYMENT.md). This is a lasting production-equivalent deployment, not temporary staging. Compatibility gaps do not block its independent existence. Administration is human email/password with project memberships; bootstrap the first administrator per [AUTH.md](AUTH.md#first-admin-bootstrap). Establish recovery/retention ownership before accepting persistent writes. Rehearse imports against separate disposable data.
3. **Operational baseline (complete):** export current application data with GET-only requests against the live LabBox read API, using an already-authorized read credential from the operator environment. The encrypted Restic repository remains an archival/recovery source only and is not a prerequisite. See [DATA-MIGRATION.md](DATA-MIGRATION.md) for the endpoint inventory, snapshot layout, transforms, and commands. Legacy tokens, human credentials, proxy secrets, and analytics are not copied. Soft-deleted tombstones are not observable through the live API and are deferred to archival recovery.
4. **Migration tooling (complete):** `scripts/migrate/` provides a GET-only exporter, a dry-run-first importer, a throttled R2 sync/verify step, a reconciliation reporter, and snapshot delta comparison, with Node-based tests. The importer preserves stable IDs and timestamps, rewrites only migrated legacy file URLs, preserves record/file relationships via additive columns (migration 0003), verifies object hashes, and is safely rerunnable. Baseline snapshot `20260919T012121Z` reconciled exactly: 1,153 records and 1,151 files (250,088,696 bytes) across `wildlife-field-recorder` and `top-hat-ferals`.
5. **Milestone B:** keep `https://lab.aismallbizguru.com` and its LabBox infrastructure authoritative and unchanged for unmigrated consumers. The CFLab operational baseline is reconciled (observations, trips, sightings, files, relationships). Pilot **Wildlife Pattern Lab** first against that baseline: route adapter, complete collection pagination before replacing IndexedDB, scoped-read diagnostic (CFLab health is not browser-CORS-enabled), exact origin, CFLab human-session or scoped machine credential, and delta refresh if the pilot must reflect newer LabBox writes. Test over 100 rows and partial-page failure without cache loss. Use opt-in GET comparisons of existing records/collections; legacy health needs additional configuration confirmation because it can create a MinIO bucket. Avoid blind dual writes.
6. Cut over one app only after acceptance. Use a short write freeze/final delta import unless a tested synchronizer exists. Issue new scoped tokens, change that client's base URL, and monitor errors. Keep the old system and export intact during a defined rollback period.
7. Roll back by restoring the prior client URL/token. Reconcile writes made after cutover before doing so; a DNS switch alone does not undo new data. Retire the VPS only after every consumer, object, backup, and rollback obligation is accounted for.

## Eventual hostname cutover (not authorized or performed here)

Resolve client/API compatibility and data synchronization **during the parallel run**, before changing the old hostname. Clients should keep the API base URL in configuration; CFLab uses relative download URLs and contains no deployment hostname in application logic. Keep the same CFLab Worker, D1 database, R2 bucket, IDs, and tokens when adding a hostname later. Do not create a new backend or move CFLab data solely to change domains.

Once acceptance and a separate cutover decision exist, the remaining work should primarily be routing `lab.aismallbizguru.com` to that existing Worker, updating host-bound routing, certificates, and monitoring, and handling the final data delta. Keep `cflab.aismallbizguru.com` available so migrated clients need not change again. No `lab` route, wildcard, redirect, or DNS change is configured in this repository now.

A routing change **alone is not compatible today**: the audited record/file routes, public reads, tokens, collection reads, and analytics dependencies must be migrated or explicitly retired; a narrowly tested adapter is an option where updating a real consumer isn't practical. Old absolute file URLs, any cookie/domain assumptions, frontend allowed origins (not the API hostname), and stale old-backend writes also need review. The remote probes cover CFLab health, optionally safe legacy health, existing-record data, bounded complete collections, optional anonymous reads, and optional GET CORS headers. They do not certify writes, binary files, browser preflight, or deletion compatibility.

**Milestone C** must account for analytics: the audit found 71 Junk Drawer pages plus Top Hat Ferals pointing at `/api/analytics/collect`, and a dashboard using five analytics read endpoints. Moving data clients does not move those tags. Leave them on LabBox during pilots, but do not route the old hostname to a Worker with no collector unless analytics has been deliberately migrated or retired. This does not require building another CFLab production stack.

## Later client migrations

- **WFR:** adapt multipart to raw uploads, normalize MIME codec parameters, preserve explicit record/file references, resolve `download_url` against the API origin, and inventory payload/file sizes against 64 KiB/8 MiB caps. Preserve/remap backend IDs already in IndexedDB before writes; changing its settings currently leaves those IDs intact. Its DELETE code accepts 204 already, but physical deletion/retention and retry behavior require acceptance. Its optional breadcrumb query is not a confirmed working legacy feature; establish actual provider/usage before implementing time filtering.
- **Top Hat Ferals:** retain deliberately public records/photos through an approved publishing mechanism; never embed privileged tokens or expose private wildlife records. Paginate all lists and sort before deriving summaries. Correct the existing photo-only PATCH: both backends replace data, and old required-field validation currently rejects that partial object. Import attachment relationships/image fallback outcomes, not just stored record JSON. Its “Test Token” button creates a real cat record; never use it for non-destructive verification.
- **Analytics:** decide on ingestion/dashboard migration or explicit retirement separately from the small data pilot. No new analytics subsystem is introduced by this audit.

## Outstanding evidence/decisions

- Which old/client revisions are actually deployed, and are additional callers/automation absent from the searched worktrees? Public reads/direct images and generated photo outcomes are confirmed for Top Hat Ferals; no generic `total` consumer was found. Retention/restore expectations remain an operator decision.
- What are real payload/object sizes and essential record/file relationships? How should Top Hat public photos be published? Which resource validations should remain frontend-owned?
- Which global/public proxy sources are active, and do their approved query parameters indirectly request other URLs?
- Are creator-token attribution, custom wildlife routes, or scheduled jobs used outside inspected clients? Analytics ingestion/dashboard usage is confirmed in source, not optional historical baggage.
- What are current data sizes, object counts/checksums, retention requirements, and acceptable cutover/rollback windows?

These questions govern client migration/cutover, not independent CFLab deployment. The [audit milestone gates](COMPATIBILITY.md#milestone-gates) distinguish them from account/resource prerequisites and remote administration.
