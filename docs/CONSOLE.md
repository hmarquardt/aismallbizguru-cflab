# CFLab operations console

`/` is the authenticated operations console for this deployment. It replaces the
previous root placeholder (a JSON 404) and is served by the existing `cflab` Worker
with the existing human authentication, D1 bindings, R2 bucket and release
pipeline. No new Worker, domain, database, SaaS dependency, CDN or frontend
framework was added, and the primary Worker still serves no static assets: the page
is one inline document with a pinned stylesheet and script.

Everything the console displays comes from a bounded query against a database this
Worker already binds, or from the recorded deployment identity. There is no
universal discovery, no Cloudflare management API credential, and no external
network call on a dashboard request.

## What exists (verified 2026-10-26)

Repository configuration and verified production state agree on this inventory;
the console only reports what is deployed.

| Kind | Resource | Notes |
| --- | --- | --- |
| Worker | `cflab` | `cflab.aismallbizguru.com`, `lab.aismallbizguru.com/*`, API, admin pages, console, Signals crons |
| Worker | `cflab-analytics` | `analytics.aismallbizguru.com`, dashboard assets, collector, sites API, hourly maintenance |
| D1 | `cflab` (`DB`) | identity, sessions, apps, records, files, project registry, console registry |
| D1 | `cflab-analytics` (`ANALYTICS`) | sites, events, daily rollups, job history |
| D1 | `cflab-bitcoin-signals` (`BTC_SIGNALS`) | observations, evidence, alerts, collection history, backup attestation |
| R2 | `cflab-files` (`FILES`) | project file objects |
| Email | `EMAIL` | invitations and optional Signals alerts |
| Projects | `analytics-dashboard`, `bitcoin-signals`, `junkstats-dashboard`, `top-hat-ferals`, `wildlife-field-recorder` | all active in production |
| Analytics sites | 6 active | Hank's Junk Drawer, Top Hat Ferals, Fruiting Forecast, Worth Looking Up, AI Small Business Guru, Turkey Vulture Software |
| Crons | `7 * * * *`, `41 6 * * *` (primary), `17 * * * *` (analytics) | Signals hourly/daily, Analytics rollup and retention |
| Workflows | `ci`, `backup`, `restore-drill`, `drift` | backup `37 3 * * *`, drift `23 11 * * *` |

## Sections

| Tab | Content | Source |
| --- | --- | --- |
| Overview | Warnings, summary cards, recent activity, database reachability | One aggregate per database, the newest Signals runs, the newest job attempts, and the three newest sessions |
| Projects | Searchable services with endpoints, access boundary, resources and repository | Seeded registry in the primary D1 |
| Databases | Allowlisted D1 inventory, schema browser, read-only SQL workbench, CSV export, saved statements | Direct D1 bindings |
| Jobs | Schedule, next run, last attempt, last success, duration, staleness, warnings | `console_jobs` metadata + `bs_collection_runs` + `console_job_runs` |
| System | Revision, binding presence, database reachability/size, backup attestation | `DEPLOY_REVISION`, binding presence, D1 catalog, `bs_backup_checks` |

Tabs load lazily: opening `/` performs the overview queries only, and each other tab
is fetched the first time it is selected. A tab is never polled.

## Authentication and authorization

* The page is a data-free shell. It reads the existing `cflab_session` token from
  `sessionStorage` (the same token `/admin/users` uses), calls `/api/auth/me`, sends
  a `401` visitor to `/admin/login`, and sends a signed-in non-administrator to
  `/account`.
* Every data route lives under `/api/admin/console/*`, which is registered inside
  the existing `/api/admin/*` prefix, so `requireHumanAdmin` runs first. A machine
  token (`cfl_…`), an unknown or expired session, a deactivated account, or a
  demoted administrator is refused exactly as for the rest of administration.
* No route accepts a binding name, a database id, a host, a SQL parameter, a
  Cloudflare credential or an arbitrary URL. The database identifier resolves
  through the existing `STORAGE_BACKENDS` allowlist in `src/projects.ts`.

## Service registry

`migrations/0012_console.sql` creates `console_services`, `console_endpoints`,
`console_resources`, `console_repositories`, `console_jobs`, `console_saved_queries`
and `console_query_audit`, and seeds the inventory above with `INSERT OR IGNORE`.
The registry is declarative: it is repository configuration applied by the release
pipeline, not a second source of truth edited at runtime, and the console has no
route that writes it. A project registered in the primary `apps` table but absent
from the seed is visible in the general project APIs and is not invented by the
console.

## The SQL workbench

The workbench is deliberately narrow.

**Allowlist.** Only `primary`, `analytics` and `bitcoin-signals` exist, resolved
through `databaseForBinding`. An unknown identifier is a `404 database_not_allowed`
and never a fallback. Schema browsing uses fixed internal catalog SQL; the caller
never supplies a table name to it. D1 does not authorize `sqlite_version()`, and its
internal `_cf_*` tables are excluded from the catalog and from inventory counts.

**Read-only enforcement** (`src/console/sql.ts`) is structural, not a `SELECT`
prefix check:

1. A real tokenizer removes line and block comments and understands single-quoted
   strings, `"`/`` ` ``/`[]` identifiers and numeric literals, so a `;` or keyword
   inside a literal can never be mistaken for SQL.
2. Exactly one statement is accepted; a second separator is refused.
3. The statement must begin with `SELECT` or `WITH`, and a `WITH` must contain a
   `SELECT`.
4. A forbidden-keyword set is scanned across every token: `INSERT`, `UPDATE`,
   `DELETE`, `REPLACE`, `UPSERT`, `RETURNING`, `CREATE`, `DROP`, `ALTER`,
   `TRUNCATE`, `RENAME`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`,
   `ANALYZE`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`,
   `TRANSACTION`, `TRIGGER`, `LOAD_EXTENSION`, `WRITEFILE`, `READFILE`,
   `FTS3_TOKENIZER`. (`END` is excluded so `CASE … END` works.)
5. Bound parameters (`?`, `:x`, `@x`, `$x`) are refused, so the only bound values
   are the pagination limits this module adds.
6. The executed text is always `SELECT * FROM (<statement>) LIMIT n OFFSET m`, with
   validated integer bounds.
7. The statement is only ever executed with `.all()`, never `.run()`, and the D1
   result metadata is checked afterwards: a reported row write or `changes > 0`
   discards the result and fails with `sql_write_detected`.

**Limits.** 8,000-character statements, 200-row pages, page ≤ 100, 5,001 fetched
rows maximum, 2,000-row CSV export (a larger result is a `413 export_too_large`
rather than a silent truncation), and one statement per request.

**Audit.** Every attempt writes one `console_query_audit` row: actor, database,
SHA-256 of the statement, statement length, status (`ok` / `rejected` / `error`),
error code, row count and duration. The statement text and the result rows are never
stored and never logged, so a log or audit row cannot leak a literal. CSV output
escapes formula-leading cells (`=`, `+`, `-`, `@`, tab, CR) exactly like the Signals
export.

**Saved statements** belong to one administrator. Reads, writes and deletes are all
scoped by `user_id`; a second administrator sees an empty list and a `404` when
deleting someone else's row. A statement is validated when saved, so a saved entry
can never hold a write.

## Job observability

`console_jobs` stores display metadata only (schedule, description, history source,
staleness threshold). Nothing in the console schedules or triggers a job; the cron
expressions stay in `wrangler.jsonc`.

* Signals runs are read from `bs_collection_runs` (cron trigger only, newest ten).
* Analytics maintenance records one row per run in `console_job_runs`
  (`migrations-analytics/0003_job_runs.sql`): job, start/finish, status, a small
  JSON summary (sites, purged, duration) and an error name. The write is best effort
  and never changes the maintenance outcome.
* The backup workflow runs in GitHub Actions, so the console reports its schedule and
  states that history is recorded by the workflow, not by the Worker. It does not
  claim a backup succeeded.
* Next-run times come from a deliberately small UTC cron reader that supports `*`,
  integer, comma lists and `*/n` for minute and hour, requires `*` for the date
  fields, and returns "unsupported" otherwise instead of guessing.
* Warnings are derived, not decorative: no success recorded, last success older than
  the threshold, last attempt failed, or history table unavailable.

## Performance budget

| Request | Database reads |
| --- | --- |
| `GET /` (shell) | 0 |
| `/overview` | ~10 small aggregates/probes (1 primary, 2 analytics, 2 signals, 4 job history, 3 reachability) |
| `/registry` | 5 primary reads |
| `/databases` | 3 catalog sums |
| `/databases/:id/schema` | 1 catalog read + 1 batch (2 statements per table, ≤ 60 tables) |
| `/databases/:id/query` | 1 statement + 1 audit write |
| `/jobs` | 1 metadata read + 1 per job |
| `/system` | 3 catalog sums + 1 attestation read |

No route calls an external API, and no tab is polled or auto-refreshed.

## API

All routes require an active administrator human session.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/console/overview` | Summary, warnings, activity, database health |
| GET | `/api/admin/console/registry` | Services, endpoints, resources, repositories, jobs |
| GET | `/api/admin/console/jobs` | Schedules with history and staleness |
| GET | `/api/admin/console/system` | Revision, binding presence, databases, backup |
| GET | `/api/admin/console/databases` | Allowlisted D1 inventory |
| GET | `/api/admin/console/databases/:id/schema` | Tables, columns, indexes, views |
| POST | `/api/admin/console/databases/:id/query` | `{sql, page?, page_size?}` → bounded rows, columns, metrics |
| POST | `/api/admin/console/databases/:id/export` | `{sql}` → CSV attachment |
| GET | `/api/admin/console/saved-queries` | The caller's saved statements |
| POST | `/api/admin/console/saved-queries` | `{name, database_id, sql}` |
| DELETE | `/api/admin/console/saved-queries/:id` | Delete one of the caller's statements |

`GET /api/health` is unchanged (`{"status":"ok","service":"cflab"}`) and
`GET /api/version` still reports the release revision.

## Tests

| File | What it proves |
| --- | --- |
| `test/console/sql.test.ts` | Literal/comment-aware tokenizing, single-statement enforcement, SELECT/WITH rule, every forbidden keyword, parameter refusal, paging bounds, CSV escaping |
| `test/console/jobs.test.ts` | Next-run arithmetic for the deployed crons, `*/n` support, unsupported expressions return unknown |
| `test/console/api.test.ts` | 401/403 boundaries for every route, demoted/deactivated admins, data-free root shell, `/api/health`, registry contents, exact database allowlist, schema and cross-database isolation, read-only refusals with unchanged data, hashed audit, paging, CSV export and oversize refusal, saved-statement privacy, job history and failures, binding presence without values |
| `test/ui/console.test.mjs` | Accessible shell, no external assets or inline handlers, sign-in and account redirects, overview rendering, lazy tabs, filtering, markup escaping of registry text, workbench run and table seeding, same-origin requests, system view |
| `test/analytics/reporting.test.ts` | One structured `console_job_runs` row per maintenance run |

## Release and verification

The schema additions are additive (`CREATE TABLE`, `CREATE INDEX`,
`INSERT OR IGNORE`) and the release gate classifies both files `additive-safe`, so no
approval file is involved. The release goes through the normal push-to-`main`
workflow; see [CI-CD.md](CI-CD.md). Live verification is recorded in
[CONSOLE-ACCEPTANCE.md](CONSOLE-ACCEPTANCE.md).


