# Bitcoin Signals production acceptance — 2026-10-26

**Final acceptance: complete.** Production treasury collection is authenticated with
the CoinGecko Demo API key held as the `cflab` Worker Secret
`COINGECKO_DEMO_API_KEY`; a real production daily collection succeeded, persisted
53 reported observations, and is visible on the authenticated Radar. The earlier
HTTP 429 blocker is closed by authenticated access, not by bypassing a limit.
Deribit remains disabled and email notifications remain off.

## Release and authorization

Initial implementation: `bf3cc485cc885b2b8eb0015907d7add0632fdb63`.
Owner correction: `53924a95feda25d47a248f43d2a03623bc236275`;
[CI/CD run 40334106133](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40334106133)
succeeded.

CoinGecko Demo authentication: `8202ac013193219f1c65e519da93ee9b3cd27691`;
[CI/CD run 40355162839](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/40355162839)
succeeded (validate → migration gate → both deploys → both production verifications).
Both Workers answered `8202ac0…` from `GET /api/version` immediately after that
release; read-only
`scripts/verify-production.mjs --service all --revision 8202ac0…` passed 21 checks
(12 primary, 9 Analytics), and `scripts/verify-drift.mjs` returned `in-sync` with
`main`. No migration was pending on any database. This acceptance record itself is a
documentation-only follow-up released by the same pipeline; it changes no behavior
and the revision and drift checks are repeated after it.

The operator installed `COINGECKO_DEMO_API_KEY` as a Worker Secret on `cflab`
(name only; the value was never read, printed, stored by the agent, or written to
`wrangler.jsonc`, the bundle, a fixture, a test, a log or this record). The released
code reads it as `env.COINGECKO_DEMO_API_KEY` and sends it only as the documented
Demo header `x-cg-demo-api-key` to
`GET https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin`
([Demo API reference](https://docs.coingecko.com/demo/reference/companies-public-treasury)).
That endpoint is listed for the Demo plan, whose limit is 100 calls/min; this
collector makes one call a day. Parser, provenance, cadence, idempotency, source
policy, access control, alerting and the data-rights posture are unchanged.

The immutable operator identity is pinned in `src/projects.ts`. A valid human
session for that active administrator is required on every Signals endpoint,
the research-bearing admin project-status API, and generic Signals record/file/
proxy routes. Memberships, global-admin status, editable project config, identity
headers and machine tokens cannot confer access. General CFLab authorization
semantics remain unchanged.

Both pre-existing administrator identities were independently confirmed still
active administrators. There were zero production Signals membership rows; none
was added or altered. No account was deleted or demoted, no password or deployment
credential changed, and neither release gate changed. The operator signed into the
normal browser login form for the collection and Radar checks; password and
session-token values were never requested, returned to the agent, logged or
recorded.

## Deployment drift from the dashboard secret write

Adding and then updating the secret through the Cloudflare dashboard created Worker
versions outside the pipeline, so production was briefly not the artifact the
pipeline released:

| Time (2026-10-26) | Version | Tag | Message |
| --- | --- | --- | --- |
| 15:00:20Z | `fde3b67f` | `bf649ee…` | CFLab release `bf649ee…` (run 40344739736) |
| 15:46:58Z | `2501aae4` | — | Add variable: COINGECKO_DEMO_API_KEY |
| 15:50:00Z | `4e788b3a` | — | Updated secret: COINGECKO_DEMO_API_KEY |
| 16:03:47Z | `75bac4b1` | `8202ac0…` | CFLab release `8202ac0…` (run 40355162839) |

`GET /api/version` kept reporting `bf649ee…` for the dashboard versions because the
new version carries the previous `DEPLOY_REVISION` over, so the revision probe alone
could not see this drift — only the untagged versions could. It was reconciled by
releasing `main` through the unchanged gated pipeline, which redeployed the committed
bundle as a tagged version and preserved the secret. No manual `wrangler deploy`,
`versions deploy` or `rollback` was used, no secret was re-set, and no gate was
weakened. `docs/CI-CD.md` now records the signal.

## Validation and acceptance matrix

Local and CI validation on the released revision: **560 tests** (368 Workers, 34 UI,
12 compatibility harness, 37 migration harness, 58 release tooling, 51 backup),
strict typechecks, chart integrity, all three local migration checks and both
dry-run bundles. The new regressions cover the authenticated request, missing
configuration and rate-limit failures. Configuration preflight: 35 checks; the
pipeline's full resource/credential preflight passed. No security/scientific
tolerance, approval gate or release gate was loosened.

| Condition | Verified result |
| --- | --- |
| Sole-owner authorization | Owner production API requests succeed. Local Workers HTTP regressions deny the second admin and ordinary users after actual read/write membership grants, reject a genuinely minted machine token, protect generic data aliases and admin status, and reject project-config/header ownership spoofing. |
| Other administrator privileges | Local authenticated tests retain user/app administration and unrelated project access for the second admin. Production confirms both accounts retain active/admin roles. |
| Unauthorized production requests | The 21-check production verification covers anonymous, unknown-human-session and machine-token rejection across Radar, Arbitrage, Evidence, Settings, status, export, admin status and the generic records routes. |
| Authenticated CoinGecko request | Production run `c6147521-a8fc-4cf0-ac8c-890b9620529c` (manual, owner-triggered from Settings) recorded `coingecko-treasury` as `ok`, 53 seen / 53 added, no error code, at `2026-10-26T16:10:41.987Z`. Local regressions prove the key is sent as `x-cg-demo-api-key`, is refused on any other host, is never placed in the URL, and never reaches an observation, run row, export or result. |
| Persisted treasury observations | 53 rows: `treasury_total_btc` 1,303,574.2192943657 BTC, `treasury_total_usd` $104,516,239,660.52, `treasury_market_cap_dominance_pct` 6.21%, and 50 `treasury_company_btc` rows (Strategy `MSTR.US` 848,517; Metaplanet `3350.T` 44,000; Twenty One Capital `XXI.US` 43,514). Every row is `tier=reported`, carries the retrieval-time observation stamp, CoinGecko attribution and the fixed evidence URL with no key material. |
| Credential containment | Production D1 contains zero occurrences of the header/credential name in observations, source runs or collection runs, and zero CoinGecko URLs with a query string or `api_key`. The key is absent from `wrangler.jsonc` `vars` and from the committed bundle; only the name appears. |
| Retained history | A 319-row production snapshot hash before and after the checks is identical (`sha256 9e5e0f3852ae2eb0f85ff46a2d9f19ee65efdd614b14804d158ec83c9c3c5823`), 0 changed rows: the authenticated collection added rows and rewrote nothing. |
| Missing configuration | Local regression: with no key, only `coingecko-treasury` fails (`missing_credential`), no request is sent unauthenticated, and the hourly job still succeeds. |
| Rate limit | Local regression: an `http_429` is recorded for that source with a sanitized message, no treasury history is written, and no retry loop is used. Production still records provider failures honestly instead of reporting success. |
| Radar | The owner confirmed on the authenticated Radar that “Reported public-company holdings” 1,303,574 BTC, “Reported treasury value” ≈ $104.52B and “Reported treasury share of market cap” 6.21% are shown, labelled reported and fresh, matching the persisted rows. |
| Arbitrage | Authenticated rendering matches retained rates, marks and indexes. Independent arithmetic checks pass for APR, native-interval APY, fee/slippage-adjusted carry, quote-to-expiry annualized basis and costs. Stale sources are excluded from the best-funding selection. |
| Evidence | The authenticated screen/API correctly show zero entries, matching D1. No fabricated production evidence was inserted. |
| Settings and administration | The authenticated screen and protected admin status report registered/reachable BTC_SIGNALS and the correct observation/evidence counts. Source failures are visible separately from database reachability. |
| Administrator operations | The existing refresh control ran the daily and hourly collections and recorded their real outcomes (daily `ok`, hourly `partial` from an upstream source). The backup-attestation control records a validated three-database report and reads back fresh/verified. |
| Existing CFLab and Analytics | 21 public/revision/authentication-rejection production probes pass at `8202ac0…`. Analytics normal login, visible dashboard and authenticated API succeed with six sites. |
| Email and Deribit | Notifications remain `{"enabled":false,"email_to":""}` with zero deliveries. Deribit remains inactive with zero retained observations. |
| Backup and restore | All three production databases independently restored with schema/row hash/count matches, integrity ok, zero foreign-key violations and fresh coverage. |

All four Signals views were navigated and visually inspected after normal login.
Before the authenticated collection the UI/API showed 238 retained observations,
eight Radar indicators, two funding venues, one dated-basis contract and zero
treasury/company rows. After it, the snapshot holds **319 retained observations**
and the Radar treasury indicators are populated. **26 independent D1/arithmetic
comparisons passed**. The two visible in-app alerts were expected `stale-source`
warnings (OKX and CoinGecko) that pre-dated authenticated collection; no email was
sent. These observations are time-stamped evidence, not an assertion that the
database stops changing after acceptance checks.

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

Pre-fix attempts, retained as history: the daily scheduled attempt at
`2026-10-26T06:41:28.574Z` and the authenticated retry at `2026-10-26T14:21:39.341Z`
(run `dc299aa3-67ea-4fa5-b807-2fb03b384e5a`) both failed with `http_429`, adding zero
treasury observations. Neither was mislabelled as a success, and neither was worked
around with a proxy, host rotation or a replacement credential.

The authenticated attempt after the released fix is a genuine success:

* run `c6147521-a8fc-4cf0-ac8c-890b9620529c`, `manual` trigger from the owner's
  authenticated Settings refresh, `2026-10-26T16:10:41.987Z`, status `ok`;
* `bs_source_runs` for `coingecko-treasury`: status `ok`, 53 seen, 53 added, no error
  code and no error message;
* 53 persisted `bs_observations` rows — the three aggregate series plus 50 companies —
  all `tier=reported`, all with `observed_at` = retrieval time, meta
  `{"observed_at_source":"retrieval","attribution":"CoinGecko"}`, and the fixed
  `https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin` evidence URL;
* the surrounding hourly refresh at `16:10:50Z` recorded `partial` with its upstream
  source failures visible, so provider problems are still reported rather than hidden.

Signals totals after the run: 319 observations (OKX 116, Kraken Futures 68,
mempool.space 48, treasury 53, Kraken spot 17, Coinbase 17), Deribit 0, notifications
off with 0 deliveries. The retained-row snapshot hash is unchanged from the
pre-collection capture, so no earlier row was rewritten.

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

Signals' 344 backup rows in that capture include 238 observations; the capture
predates the authenticated treasury rows. Captures were 14:15:11 UTC (primary),
14:15:22 UTC (Analytics) and 14:15:32 UTC (Signals). Independent backup
freshness returned `ok=true`, all three fresh within 30 hours. The existing
administrator attestation was recorded at 14:37:52 UTC and the protected Settings/
status API read back `recorded=true`, `ok=true`, storage reachable and email off.
No stored backup or archive was deleted or overwritten. The next scheduled backup
run captures the treasury rows; append-only storage means no earlier artifact is
overwritten.

## Unperformed checks

- A direct production request using the second administrator's valid live session
  was not performed. Their credentials/session were neither requested nor
  manufactured. Valid non-owner sessions, ordinary membership grants and valid
  machine tokens are exercised by the local Workers regression suite; the exact
  tested correction is deployed. Public negative production probes and positive
  owner requests were separately verified.
- Production Evidence create/update tests were not performed against invented
  content. Owner write/review validation is covered by the isolated suite.
- The provider-side Demo credential was verified only through the successful
  authenticated collection; the key value itself was never read by the agent, so
  its format or account association is asserted by the operator, not by the agent.

No acceptance blocker remains. The next scheduled daily run at `06:41` UTC repeats
the verified path, and the schedule, parser, provenance and retention rules are
unchanged by this fix.

Private browser screenshots, API/D1 comparison data and logs are kept outside
Git; this record contains no live quote dataset, password, session token or API key.
