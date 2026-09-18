# LabBox migration

## Reference and status

The old source is available at `../aismallbizguru-lab`, repository `aismallbizguru-lab`. This pass inspected the working-tree code and recorded HEAD `b0f1bb5f33b9333ad4e2a0add2fb00aed9aa0d92`. No old files, resources, data, or DNS were changed. This is source-level comparison, not proof that the inspected tree matches the deployed version or every current client.

Reviewed: `backend/app/records/{routes,schemas,service}.py`, `auth/{dependencies,tokens}.py`, `files/{routes,schemas}.py`, `proxy/{routes,service,schemas}.py`, `config/models.py`, and `health/routes.py`.

## Compatibility matrix

| Area | Inspected LabBox | CFLab MVP / required work |
| --- | --- | --- |
| Health | `/health`, DB and optional storage checks, version/host fields | `/api/health`, liveness only; change monitors |
| Records | `/api/{app_id}/{resource}[/{record_id}]` | `/api/apps/{app}/resources/{resource}/records[/{id}]`; update clients or add tested adapter |
| Payload | `{data: {...}}`; PATCH replaces supplied data | Same envelope/replacement concept; data required on create, empty PATCH rejected; optional relational status |
| Lists | `{records, total}`, all records, newest first | Bounded `{records, next_cursor}`, UUID order; clients must paginate and cannot assume chronology |
| Deletion | Soft delete; `{status: "deleted"}` | Permanent deletion; HTTP 204; decide retention before migrating a client |
| Record output | Creator token ID, deleted timestamp, linked files, image fallback | Core fields and status only; explicit client file references needed |
| Resources | YAML registry; declared resources and required-field validation | Implicit namespaces, object payloads; no application schema enforcement |
| App config | YAML-derived public registry | Authenticated per-app JSON configuration in D1 |
| Auth | Tokens may span apps; app-level read/write or wildcard; some public reads | One app per token, explicit capability scopes, no public reads; issue new tokens |
| Token hashes | SHA-256 of opaque random token | SHA-256 but new `cfl_` format/scope semantics; do not blindly import token rows |
| Files | Multipart attached to a resource/record; `/api/files/{id}` download; soft deletion | Raw app-owned uploads; scoped content URL; physical delete; no native record relationship |
| Proxy | `/api/proxy/{slug}`; global sources, optional public access, configurable redirects/cache | Per-app authenticated sources, no redirects/cache, strict operator host allowlist |
| Admin | Custom cookie/password/session routes/UI | Local CLI administration now; verified Cloudflare Access integration before remote admin |
| Special features | Wildlife trip aggregation, analytics, workers/jobs, backups | Not ported; inventory active consumers separately |
| Errors | FastAPI `detail` envelopes | `{error:{code,message}}`; update client error handling |

No automatic route aliases are installed. Compatibility-sensitive routing lives in `src/app.ts`; request/response shapes live in `src/routes/records.ts` and `files.ts`; token semantics live in `src/auth/tokens.ts`; proxy policy lives in `src/proxy/`. Add a small explicit compatibility router only after real consumer fixtures identify which translations are required. Do not reproduce any legacy cross-app authorization weaknesses while adapting routes.

## Parallel-run plan

1. Inventory each live app, routes used, required resource fields, public-read expectations, linked files, token permissions, proxy policies, and app-specific endpoints. Confirm the deployed LabBox revision and capture sanitized API fixtures from clients. Decide whether to update each frontend or supply an adapter.
2. Create isolated CFLab staging resources and verified Access administration. Establish backup/restore and deletion/retention policy. Rehearse all imports against disposable data.
3. Export a consistent SQLite snapshot, YAML app config, proxy definitions, and an object inventory from MinIO. Record counts, IDs, timestamps, deletion state, and checksums. Never export plaintext secrets into Git. Translate app/resource identifiers and token scopes explicitly.
4. Build a repeatable, audited import tool after these mappings are agreed. Preserve valid UUIDs and timestamps when useful; export/import SQL can populate them even though the create API generates them. Separate tombstones from live data. Copy bytes to new R2 keys, verify checksums, then import matching metadata. Map old record/file relationships into an agreed schema or client payload field. No import tool or production migration is claimed in this pass.
5. Keep LabBox authoritative. Run CFLab alongside it on a different hostname, compare counts, samples, and read behavior, and exercise one pilot app. Avoid blind dual writes; if needed, define an idempotent application-specific synchronization method and reconcile failures.
6. Cut over one app only after acceptance. Use a short write freeze/final delta import unless a tested synchronizer exists. Issue new scoped tokens, change that client's base URL, and monitor errors. Keep the old system and export intact during a defined rollback period.
7. Roll back by restoring the prior client URL/token. Reconcile writes made after cutover before doing so; a DNS switch alone does not undo new data. Retire the VPS only after every consumer, object, backup, and rollback obligation is accounted for.

## Outstanding evidence/decisions

- Which old revision is actually deployed, and which clients depend on public reads, newest-first lists, `total`, soft deletion, or generated image URLs?
- Which resource validations and record/file relationships are essential? Do clients require files larger than 8 MiB or direct `<img>` access (which cannot supply bearer headers)?
- Which global/public proxy sources are active, and do their approved query parameters indirectly request other URLs?
- Are creator-token attribution, custom wildlife routes, analytics ingestion, or scheduled jobs still used?
- What are current data sizes, object counts/checksums, retention requirements, and acceptable cutover/rollback windows?

These questions govern compatibility work; none prevents using the isolated local MVP.
