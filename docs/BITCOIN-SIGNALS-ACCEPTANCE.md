# Bitcoin Signals production acceptance — 2026-10-26

**Status: incomplete.** The initial production release and independent
three-database restore drill succeeded. This record distinguishes those results
from the final owner restriction and authenticated acceptance checks.

## Project-specific owner correction

Signals access is pinned to the existing operator's immutable user ID in
`src/projects.ts`. The owner must retain an active administrator account and
present a valid human session. No account or credential is created, deleted,
demoted or changed by this correction.

The same policy protects every `/api/bitcoin-signals/*` research/operation route,
`/api/admin/projects/bitcoin-signals/status`, and the generic Signals record/file/
proxy routes. Project memberships, global-admin status, editable project config,
identity headers and machine tokens cannot confer access. Ordinary membership
management remains available but cannot grant Signals research access. General
CFLab administrator and other project semantics remain unchanged. General project
lists expose only identity/storage metadata, without research observations or
alerts. No migration, dependency, service or alternate release path is introduced.

Local verification passes: **553 tests** (361 Workers, 34 UI, 12 compatibility
harness, 37 migration harness, 58 release tooling, 51 backup), typechecking,
vendored-chart verification, all three local migrations, both dry-run builds,
`git diff --check` and 35 configuration preflight checks. Regression tests use
actual authenticated requests and ordinary membership/token-management APIs in
isolated local test databases. They verify owner success, non-owner denial after
read/write grants, second-admin privileges elsewhere, rejection of a genuinely
issued machine token, project-config/header spoof resistance, and denial before
unauthorized collection or email settings writes.

The accompanying correction must be committed/pushed and pass the unchanged
GitHub Actions gates before its production behavior is accepted. Production
results are recorded separately after the workflow completes; local results do
not prove production authentication.

## Verified production evidence before the correction release

- Initial released commit: `bf3cc485cc885b2b8eb0015907d7add0632fdb63`.
- CI/CD run 40246368371 succeeded, including additive migration gates and both
  Worker revision checks. Additional 21 public/revision/auth-rejection probes and
  the drift check passed.
- Production BTC_SIGNALS UUID: `7630355d-eae7-4410-aef5-7a0486ddc523`.
- The first hourly cron at 00:07 UTC stored 111 genuine observations. The next
  successful hourly run at 01:07 stored 12 more. As of the 13:07 run, production
  retained 229 observations from 13 hourly runs: four wholly successful, nine
  partial. The first 111 rows including provenance remained exactly unchanged
  across those runs (canonical JSON SHA-256
  `c0b6ad1223e3917be261adcd7a77af1b143bf365b97f08249f0a1d0967e38f4c`).
- The daily scheduled handler actually ran at 06:41:28 UTC. It received HTTP 429
  from CoinGecko and stored zero treasury rows. Nine hourly runs also received
  HTTP 429 from OKX while the other four sources continued collecting. These are
  upstream rate limits, not successful treasury collection. Do not bypass them,
  rotate hosts/proxies, invent data or claim the daily acceptance condition passed.
- Email notifications remain disabled, recipient empty, zero deliveries.
  Deribit remains inactive with zero observations. Source-health alerts are
  retained as deterministic research-tool warnings; no mail is enabled.
- Backup run 40248736111 and independent restore run 40249049084 succeeded for
  all three databases. Stored artifact hashes were verified, then schema, row
  hashes/counts, integrity and foreign keys were checked in isolated LOCAL D1
  restores. Primary: 13 tables / 3276 rows; Analytics: 16 / 1883; Signals:
  13 / 135, including the first 111 observations. Every integrity check passed,
  zero foreign-key violations, all three freshness entries green. These captures
  predate later collections; existing artifacts were preserved.

## Outstanding final checks

- Deploy and verify the owner correction through the existing gated pipeline.
- The operator signs in normally in the separate verification browser. Passwords
  and session-token values must not be requested, returned, logged or recorded.
- Verify Radar, Arbitrage, Evidence, Settings and administrator operations against
  production D1; verify authenticated existing CFLab/Analytics operations.
- Validate a successful production daily treasury collection through the existing
  scheduled-handler collection path, subject to upstream rate limits. The actual
  scheduled attempt failed; a local successful parser probe cannot substitute.
- Record any production second-user check that could not be performed without
  another account's normal session; do not forge or insert production sessions.
- Capture/restore a fresh backup after any successful treasury collection and
  record the existing authenticated backup freshness attestation if available.

Final acceptance must not be marked complete while required authenticated or
successful production treasury checks remain unverified.
