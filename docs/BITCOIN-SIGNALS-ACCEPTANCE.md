# Bitcoin Signals production acceptance — 2026-10-26

**Final acceptance: incomplete — production treasury collection is rate-limited.**
The owner correction, authenticated views, other application checks, real history
persistence and independent three-database restore succeeded. A successful daily
CoinGecko production collection has not been verified and is not claimed.

## Release and authorization

Initial implementation: `bf3cc485cc885b2b8eb0015907d7add0632fdb63`.
Owner correction: `53924a95feda25d47a248f43d2a03623bc236275`;
[CI/CD run 40334106133](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40334106133)
succeeded. Both Workers reported that correction revision and the drift check
was in sync with main. No migration was pending on any database. Subsequent
acceptance-record commits contain documentation only and use the same pipeline.

The immutable operator identity is pinned in `src/projects.ts`. A valid human
session for that active administrator is required on every Signals endpoint,
the research-bearing admin project-status API, and generic Signals record/file/
proxy routes. Memberships, global-admin status, editable project config, identity
headers and machine tokens cannot confer access. General CFLab authorization
semantics remain unchanged. General admin project lists contain identity/storage
metadata, without research observations or alerts.

Both pre-existing administrator identities were independently confirmed still
active administrators. There were zero production Signals membership rows; none
was added or altered for these tests. No account was deleted or demoted, no
password or deployment credential changed, and neither release gate changed.
The operator signed into normal browser login forms; password/session-token
values were never requested, returned to the agent, logged or recorded.

## Validation and acceptance matrix

Local and CI validation: **553 tests** (361 Workers, 34 UI, 12 compatibility
harness, 37 migration harness, 58 release tooling, 51 backup), strict typechecks,
chart integrity, all three local migration checks and both dry-run bundles.
Configuration preflight: 35 checks; the pipeline's full resource/credential
preflight passed. No security/scientific tolerance or approval gate was loosened.

| Condition | Verified result |
| --- | --- |
| Sole-owner authorization | Owner production API requests succeed. Local Workers HTTP regressions deny the second admin and ordinary users after actual read/write membership grants, reject a genuinely minted machine token, protect generic data aliases and admin status, and reject project-config/header ownership spoofing. |
| Other administrator privileges | Local authenticated tests retain user/app administration and unrelated project access for the second admin. Production confirms both accounts retain active/admin roles. |
| Unauthorized production requests | 24 read-only cases across Radar, Arbitrage, Evidence, Settings, status, export, admin status and generic records all returned 401/error-only for anonymous callers, unknown human sessions and machine-token probes. |
| Radar | Authenticated rendering and direct API values match production D1: source, series, venue, value, timestamp and tier. Stale OKX quotes remain visibly stale. |
| Arbitrage | Authenticated rendering matches retained rates, marks and indexes. Independent arithmetic checks pass for APR, native-interval APY, fee/slippage-adjusted carry, quote-to-expiry annualized basis and costs. Stale sources are excluded from the best-funding selection. Unrounded D1 timestamps are used in the arithmetic check, not the rounded displayed day count. |
| Evidence | The authenticated screen/API correctly show zero entries, matching D1. No fabricated production evidence was inserted. |
| Settings and administration | The authenticated screen and protected admin status report registered/reachable BTC_SIGNALS and the correct observation/evidence counts. Source failures are visible separately from database reachability. |
| Administrator operations | The existing daily refresh dispatches and records its actual provider failure; the existing backup-attestation control successfully records a validated three-database report and reads back fresh/verified. |
| Real persistence | A second fully successful hourly cron stored 12 new observations. The original 111 rows, including values and provenance, remain exactly unchanged after later production runs. |
| Production daily treasury | **Failed:** actual 06:41 UTC scheduled attempt and one bounded 14:21 UTC authenticated retry both received HTTP 429 from CoinGecko, adding zero treasury observations. The retry uses the existing daily collection implementation; it is not mislabelled as a successful scheduled trigger. |
| Existing CFLab and Analytics | 21 public/revision/authentication-rejection production probes pass. Authenticated CFLab project listing succeeds with all five active projects. Analytics normal login, visible dashboard and authenticated API succeed with six sites at the corrected revision. |
| Email and Deribit | Notifications remain disabled, recipient empty, deliveries zero. Deribit remains inactive with zero retained observations. |
| Backup and restore | All three production databases independently restored with schema/row hash/count matches, integrity ok, zero foreign-key violations and fresh coverage. |

All four Signals views were navigated and visually inspected after normal login.
At 14:27 UTC the UI/API showed **238 retained observations**, eight Radar
indicators, two funding venues, one dated-basis contract and zero treasury/company
or curated-evidence rows. **26 independent D1/arithmetic comparisons passed**.
The two visible in-app alerts are expected `stale-source` warnings for OKX and
CoinGecko; no email was sent. These observations are time-stamped evidence, not
an assertion that the database stops changing after acceptance checks.

## Production collection evidence

The first hourly cron ran at 00:07:31 UTC and successfully retained 111 genuine
observations: OKX 102, Kraken Futures 4, Kraken spot 1, Coinbase 1, mempool.space 3.
The next successful hourly run at 01:07 retained 12 more. At the 13:07 snapshot,
13 hourly runs had retained 229 observations: four wholly successful and nine
partial. The 14:07 partial run brought the authenticated snapshot to 238. Partial
runs recorded upstream OKX HTTP 429 while the other four sources continued.
Collection did not substitute fake data, bypass rate limits or rewrite history.

The first 111 rows' canonical JSON SHA-256 remained
`c0b6ad1223e3917be261adcd7a77af1b143bf365b97f08249f0a1d0967e38f4c`
across the first and later production snapshots. This is actual persistence across
collection runs, beyond the earlier isolated local idempotency tests.

Daily scheduled attempt: `2026-10-26T06:41:28.574Z`, failed / `http_429`.
Authenticated bounded retry: `2026-10-26T14:21:40Z`, run
`dc299aa3-67ea-4fa5-b807-2fb03b384e5a`, failed / `http_429`.
There are no successful production CoinGecko observations to verify yet. A local
API probe or local successful treasury drill does not substitute for this result.

## Independent production backup/restore

[Backup run 40337849021](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40337849021)
succeeded under the owner-corrected revision. It captured all tables inside one
request per database, created/populated parents before children, restored and
verified each dump, then uploaded unique append-only artifacts. The existing file
mirror also succeeded without modifying source objects.

A separate [restore run 40342159814](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40342159814)
downloaded those stored artifacts, checked their SHA-256/size, and restored all
three into isolated LOCAL databases. It created no cloud resource and never
restored into production. Schema and per-table row hashes/counts matched;
`quick_check=ok`, foreign-key violations zero throughout.

| Database | Tables | Rows | Artifact SHA-256 |
| --- | ---: | ---: | --- |
| cflab | 13 | 3276 | `15dd55b79d3a231c79695b9f84617aba2f9602f95add501e1d8f73b5f0a67545` |
| cflab-analytics | 16 | 1905 | `fb59b0d71eed48b08cb837d4e3bbde5f8df8585e720a2c1d4a16aca73cb2bd65` |
| cflab-bitcoin-signals | 13 | 344 | `93725e0bb99d8a401b686f72b7a4fcfa36f1ee46bd9edc7160b453942b87b4d4` |

Signals' 344 backup rows include 238 observations. Captures were 14:15:11 UTC
(primary), 14:15:22 UTC (Analytics) and 14:15:32 UTC (Signals). Independent backup
freshness returned `ok=true`, all three fresh within 30 hours. The existing
administrator attestation was recorded at 14:37:52 UTC and the protected Settings/
status API read back `recorded=true`, `ok=true`, storage reachable and email off.
No stored backup or archive was deleted or overwritten.

## Unperformed checks and remaining blocker

- Successful end-to-end production treasury ingestion/persistence remains blocked
  by the provider's HTTP 429 responses. The failed attempts are verified; success
  is not. No proxy/host rotation, new key, credential change or new service was
  introduced to work around the restriction.
- A direct production request using the second administrator's valid live
  session was not performed. Their credentials/session were neither requested
  nor manufactured. Valid non-owner sessions, ordinary membership grants and
  valid machine tokens are exercised by the local Workers regression suite;
  the exact tested correction is deployed. Public negative production probes
  and positive owner requests were separately verified.
- Production Evidence create/update tests were not performed against invented
  content. Owner write/review validation is covered by the isolated suite.

The next acceptance step is a successful permitted production response from the
existing treasury provider, followed by verification of the resulting history.
Until that is verified, **final production acceptance remains incomplete**.

Private browser screenshots, API/D1 comparison data and logs are kept outside
Git; this record contains no live quote dataset, password or session token.
