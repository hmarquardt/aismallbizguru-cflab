# Operations console acceptance — 2026-10-26

Scope: the authenticated console at `/`, the `/api/admin/console/*` API, the
declarative service registry, the read-only D1 workbench, job observability, and the
system view. This record distinguishes what was verified locally and in CI from what
was verified against production.

## Repository and production inventory that the console reports

Discovery was done against the repository configuration and read-only production
queries before implementation. Repository and production agreed:

* Workers: `cflab` (primary) and `cflab-analytics`, released together by
  `.github/workflows/ci.yml`.
* D1: `cflab` (`DB`), `cflab-analytics` (`ANALYTICS`),
  `cflab-bitcoin-signals` (`BTC_SIGNALS`) — the three `wrangler.jsonc` /
  `wrangler.analytics.jsonc` entries and the three production UUIDs.
* R2: `cflab-files` (`FILES`). Email: the `EMAIL` send_email binding. Rate limits:
  `RL_LOGIN`, `RL_RECOVERY`, `RL_RESET`, `RL_ANALYTICS`, `RL_INVITE`.
* Projects (`apps`, all active): `analytics-dashboard`, `bitcoin-signals`,
  `junkstats-dashboard`, `top-hat-ferals`, `wildlife-field-recorder`;
  `project_storage` maps `bitcoin-signals` to `BTC_SIGNALS`.
* Analytics sites (active): 6.
* Crons: `7 * * * *` and `41 6 * * *` on the primary Worker, `17 * * * *` on the
  Analytics Worker. GitHub workflows additionally run backups at `37 3 * * *` and a
  drift check at `23 11 * * *`.
* Before this change, `GET /` returned `404 application/json`; there was no root
  page to preserve. `GET /api/health` and `GET /api/version` were the existing
  machine-readable endpoints and are unchanged.

## Local and CI verification

`npm run check` passes: strict typechecks for the Worker and test projects, the
vendored-asset check, the Workers Vitest suite, the happy-dom UI suite, the offline
compatibility harness, the migration harness, the release-tooling tests, and the
backup tests. Both dry-run bundles build. All three local migrations apply.

New coverage:

| Area | Result |
| --- | --- |
| Access control | Anonymous, machine-token, unknown-session, non-administrator and revoked/demoted-administrator requests are refused on every console route; no refused request writes an audit row |
| Root shell | Returns HTML with no measurements; `/api/health` and `/api/version` unchanged |
| Registry | 8 services, 60+ endpoints, resources including `DB`/`ANALYTICS`/`BTC_SIGNALS`/`FILES`, one repository, four schedules |
| Database isolation | Exactly `primary`/`analytics`/`bitcoin-signals` are reachable and no identifier resolves a raw binding; the Analytics schema exposes no primary tables |
| Read-only gate | `DELETE`/`UPDATE`/`INSERT`/`DROP`/`PRAGMA`/`ATTACH`, multi-statement input, a write CTE and bound parameters are all refused with stable codes and the data is unchanged |
| Paging and export | 120-row CTE pages as 50/50/20 with correct `has_more`; CSV escapes formula cells; a 2,100-row export returns 413 |
| Audit | One hashed row per attempt, no statement text |
| Saved statements | Visible only to their owner; a second administrator cannot list or delete them; writes are refused at save time |
| Jobs | Next-run arithmetic for the deployed crons; real Signals cron history is read; a failed latest attempt is flagged; the external backup workflow reports `external` rather than implying success |
| System | Binding presence only; the CoinGecko secret value never appears; backup attestation state is reported |
| Analytics history | One `console_job_runs` row per maintenance run |

The two schema additions (`migrations/0012_console.sql`,
`migrations-analytics/0003_job_runs.sql`) are classified `additive-safe` by
`scripts/ci/migration-gate.mjs`, so no approval entry is involved.

## Production verification

The console was released only through the gated `validate → deploy → verify`
pipeline. Three releases were required because the first two exposed defects that
the tests did not catch (recorded honestly below):

| Release | Run | Outcome |
| --- | --- | --- |
| `1583584` | [40363848554](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40363848554) | Console and both migrations live; three tabs rendered blank in a real browser |
| `57ced82` | [40366720356](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40366720356) | Scroll reset and visible panel errors added; blank symptom persisted |
| `5bde537` | [40368238171](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40368238171) | Unclosed `#tab-projects` section fixed; all five tabs verified |

### Defect found in production and its fix

The first release served a shell in which `#tab-projects` was missing its closing
`</section>`. A real HTML parser therefore nested `#tab-databases`, `#tab-jobs` and
`#tab-system` inside `#tab-projects`: clicking one of them unhid a panel whose
ancestor was hidden, so Overview and Projects looked correct while the other three
appeared blank. happy-dom silently auto-closed the section at `</main>`, so the DOM
tests passed. The fix restores the closing tag and adds a parser-independent
regression: every `[role=tabpanel]` must be a direct child of `<main>`, must not
contain another panel, and the shell's section tags must balance. The repaired live
HTML was then parsed and executed by headless Chrome, which showed all five panels
as siblings under `<main>` and each one visible with content after a click. The
operator then confirmed all five tabs render in a normal signed-in session.

Lesson recorded: string assertions and a lenient DOM are not sufficient for a page
whose behaviour depends on element nesting; the structural test and a real-engine
check are now part of the suite.

### Verified live state

| Check | Result |
| --- | --- |
| Revision | Both Workers report `5bde53799aee6c7e6ff7a91577a54bc26f11dfad`; `verify-production.mjs --service all --revision …` passes 21 checks; `verify-drift.mjs` is `in-sync` |
| Root shell | `GET /` → 200 `text/html`, 39,055 bytes, balanced sections (12/12), no measurements, no external asset or inline handler |
| Unchanged endpoints | `GET /api/health` → `{"status":"ok","service":"cflab"}`; `GET /api/version` reports the revision |
| Unauthenticated API | `/api/admin/console/overview` and a `POST …/databases/primary/query` each return 401 `unauthorized` |
| Registry rows in production D1 | 8 services, 63 endpoints, 9 resources, 1 repository, 4 jobs (`signals-hourly`, `signals-daily`, `analytics-maintenance`, `backup-workflow`) |
| Overview metrics (operator-confirmed and matched to D1) | Projects 5 (5 active), users 2 (2 administrators), sessions 8, Analytics sites 6, Signals observations 319, databases 3 reachable, jobs 4 |
| Tabs | Operator confirmed Overview, Projects, Databases, Jobs and System all render after a hard refresh |
| Workbench, cross-database | Authenticated query at `2026-10-26T17:29:36Z` on `bitcoin-signals`: status `ok`, one row, 40 ms. The same statement on `primary` at `17:29:11Z` failed with `sql_error` ("no such table"), proving the selector targets the chosen binding and does not leak across databases |
| Audit | Two rows written for those attempts, each holding a 64-character SHA-256 and a statement length — no statement text, no result rows |
| Job history | The `17:17:58Z` Analytics maintenance run recorded `ok`, 6 sites, 0 purged, 5,226 ms in `console_job_runs` |
| Backups | No backup was created or restored by this change; the System tab reads the existing attestation (checked `2026-10-26T14:37:52Z`) |

### Not claimed

* No authenticated screenshot or query transcript is committed; the record above
  contains counts, timings and hashes only.
* No saved statement had been created in production at the time of this record, so
  the per-administrator saved-query path is verified by tests, not live usage.
* The scheduled Signals daily collection (`06:41` UTC) and the external backup
  workflow were not re-triggered for this acceptance; their history is read from the
  subsystem that already records it, and the console reports an external workflow as
  `external` rather than asserting success.

