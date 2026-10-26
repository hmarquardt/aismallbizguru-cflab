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

Release and live checks are appended below once the gated pipeline has released this
commit. Nothing in this section is claimed until it has been observed.
