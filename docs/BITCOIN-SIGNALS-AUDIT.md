# Bitcoin Signals independent audit — 2026-10-25 (pre-release evidence)

**Pre-release verdict: audit corrections and authorized provisioning completed; production verification remains pending.**
This report records evidence before the production release. The operator subsequently
authorized commit/push, additive pipeline migrations and deployment through unchanged
gates; release results must be verified separately rather than inferred from this audit.
The operator authorized creation of **only** `cflab-bitcoin-signals`, then
authorized restoring legally defensible private research sources and the narrow
CoinGecko retention exception. Deribit remains disabled for US residency. That database now exists with UUID
`7630355d-eae7-4410-aef5-7a0486ddc523`; its production schema is still empty.
No production migration, data mutation, credential change, backup deletion, commit, push or
Worker deployment was performed. Existing gates, archives, backups, R2 objects,
domains, services and Worker revisions were preserved. Backup credentials were
used only for the documented read-only freshness report.

## Scope and evidence

Reviewed the actual tracked working-tree diff and new Signals source, dashboard,
schemas, tests, and operations files against `main` at
`210aad9e0daf1f59654dd02547cdcd6b6ccdd1fb`. Read `AGENTS.md`,
`BITCOIN-SIGNALS.md`, and the release/backup runbooks. No separate implementation
completion report or original detailed requirements brief was found in the
repository; full conformity to such a document cannot be independently certified
until it is supplied. The coverage assessment below uses the task and the
implementation's documented six signals.

## Findings and corrections

| Finding | Correction and verification |
| --- | --- |
| Kraken's hourly relative funding rate was treated as eight-hour, understating APR by 8×; its linear contract was called inverse. | Multiply by eight, preserve native interval/raw rate, correct contract descriptions; parser and arithmetic regression tests. [Kraken specification](https://support.kraken.com/ca/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications). |
| Normalized rates lost the native interval for APY. | APR uses 1095 normalized periods; hypothetical APY compounds the native rate at its native interval. Tests include hourly and negative funding. |
| A modal/default history interval could silently misnormalize an interval change. | OKX history uses exact adjacent settlement gaps independently; unknown first periods/gaps are omitted. Current intervals are no longer rounded. Mixed-interval regression passes. |
| Sampled, overlapping predictions were summed as income; short settled periods were summed at normalized size. | Sampled cumulative return is null; settled cumulative return sums native payouts. |
| Dated-future costs used the perpetual holding window, and quote annualization changed with wall-clock age. | Quote-to-expiry is the common basis/cost horizon; expired/imminent contracts are excluded. Deribit uses its actual index rather than estimated delivery price. |
| OKX USDT prices were labelled USD. | Price units/definitions explicitly say USDT per BTC, with no implied USD conversion. Existing series keys are retained. |
| Old funding could trigger alerts; the same treasury change could be re-alerted on a new day. A global recent-run limit could lose a daily source. | Funding requires a recent non-future sample; treasury compares distinct observation days and deduplicates by observation day; source health reads bounded history separately per source. |
| Scheduled interval checks and manual rate-limit counts could race. Unknown crons silently ran hourly collection. | Check scheduled interval under the lease; atomically reserve manual slots across both jobs; always release leases; reject unknown cron expressions. Partially rejected/empty sources no longer make a run look wholly successful. |
| Deactivated projects remained accessible through the Signals API. | Require active project identity before resolving membership. Tests cover deactivation and revoked memberships. |
| Invalid multi-field settings/evidence updates could save earlier fields, including enabling mail. | Validate everything before an atomic D1 batch. Regression confirms an invalid request cannot enable notifications. |
| Hypothesis counts ignored each link's effect. | Aggregate the linked hypothesis effect, with a contradictory-effect regression. |
| A stopped venue disappeared after healthy venues added enough rows; very short histories showed a seven-day change. | Select latest row per venue before limiting results; require a reference within a day of the weekly horizon. |
| Backup attestations could remain green indefinitely and trusted a fresh label without a capture timestamp. | Require capture timestamps, exactly one entry per database, recompute and expire freshness. Reject malformed/future backup manifests for freshness. |
| Three operational files duplicated the new database ID. | Wrangler production configuration is authoritative; backup metadata and restore protection derive IDs from it. Full preflight additionally checks all three real Cloudflare database identities. Existing primary/Analytics identity guards remain. |
| Restore verification failures did not fail the CLI; an alias could bypass the production-name guard. Snapshot dumping could fall back to inconsistent per-table reads. | Fail on restore mismatch, inspect the target config's actual ID/name, refuse environment overrides, and stop if a single-request snapshot fails. Add schema-definition hashes to new manifests. Actual isolated local roundtrip passes. |
| Restore workflow's legacy `both` option selected no databases. | Restore selection now includes the first two for `both`, all three for `all`. |
| Spreadsheet exports could execute text formulas; oversized upstream streams were left open. | Escape formula-leading text without changing numeric values; cancel over-budget streams. Transport tests reject redirects, credentials, untrusted hosts, non-JSON, malformed JSON and HTTP 429. |
| Provider rights were initially judged too broadly for a one-user personal tool. | Specific Kraken public-API instructions support restoring spot/funding/basis. Deribit personal processing is permitted but US access is restricted. The operator accepted the OKX personal-analysis interpretation and narrowly authorized resolving CoinGecko termination retention. Both adapters are restored; Deribit stays disabled for US residency. See the data-rights review. |

A second provider-policy review added a fixed server-side permission boundary in
`src/bitcoin-signals/policy.ts`. It controls job selection, transport, dashboard and
history reads, calculations, CSV export, alert evaluation/display and administration
counts. Fresh migration seeds mark restricted providers inactive; an old active
registry row cannot override policy. Restricted adapters remain covered by offline
synthetic parser tests, with no live request or test-data promotion. Disabled
sources appear as disabled with a reason, not as failing/stale sources.

No feature, dependency, service, deployment path, or infrastructure domain was added.

## Requirement coverage

| Area | Independent result |
| --- | --- |
| Six research signals | Spot price and public Lightning statistics have enabled collectors; curated evidence remains available. OKX/Kraken spot/funding/basis and daily CoinGecko treasury are enabled for confirmed private personal use. Deribit is disabled for US residency. Calculations/adapters are tested offline. Automatic funding/basis and treasury coverage is restored; excluded Deribit data is not substituted or simulated. Full original-brief conformity remains unverified because the separate report/brief was unavailable. |
| Authentication and membership | Human sessions only; primary-DB session/user state plus project membership; read/write/admin separation; active project check. No arbitrary binding, SQL or table is accepted. No upstream credentials are configured or emitted by the collectors. |
| Existing CFLab and Analytics | Local compatibility/auth/admin/Analytics suites pass. Existing production public projections, auth boundaries, collect-route ownership and Analytics service binding pass read-only probes. |
| D1 and migrations | Third binding and independent schema/migration ledger are present; migration-classification tests include both new additive migrations. Local schemas migrate successfully. Production third DB exists, with zero tables and migration pending. |
| Hourly/daily schedule | Production/local handlers map `7 * * * *` and `41 6 * * *` to the respective jobs and use `waitUntil`; shared leases and rate-limit behavior are tested. Actual production invocations remain unverified. |
| Collection | Seven adapters retained, two enabled: two fixed hourly HTTP requests, zero daily data requests while no daily provider is approved. The daily handler still evaluates alerts and returns `no_enabled_sources`. No retries/pagination loop; 8-second/request and 1.5 MB/body caps remain. Failures are source-isolated and retained observations remain idempotent. |
| Mathematics | Native funding units, signed APR/APY, fees/slippage, expiry basis and cumulative payout corrections pass regressions. Values remain indicative; no trading, leverage return, guaranteed income or executable contract conversion is claimed. |
| Alerts/email | Notifications seeded off; only administrators can enable/configure delivery. Atomic alert insertion deduplicates concurrent evaluations; failed delivery is recorded. Tests verify no duplicate delivery. No production Signals mail could have been sent by this undeployed implementation. |
| Three-database operations | CI local migrations, remote migration gate, resource preflight, backup registry, restore protection, freshness and drill selection include Signals. Production probes include Signals shell and anonymous/machine/unknown-session rejection. Authenticated data/scheduled-run verification remains a post-release operation. |

## Local validation

The personal-use policy `npm run check` passes: strict TypeScript, vendored-chart verification,
358 Workers tests, 34 UI tests, 12 compatibility-harness tests, 37 migration-harness
tests, 58 release-tooling tests and 51 backup tests (**550 tests total**).
All three local migration commands and both dry-run Worker builds pass, as does
`git diff --check`. Restricted-provider parser assertions were retained in offline
adapter tests; new end-to-end tests prove collection/reporting exclusions, source
policy precedence over legacy registry flags, suppression of old alerts and email,
and preservation of quarantined rows. No security or scientific tolerance was loosened.

**Configuration preflight: 35/35 pass. Live database identity checks: 3/3 match.**
The latter use read-only `wrangler d1 info` with existing OAuth and match actual
names/UUIDs to the authoritative configuration. They do not prove the scopes of
GitHub's separate deployment/migration/backup tokens. Full release-context checks
(released commit SHA, both CI credentials, approved remote migrations and deployment)
remain unexecuted; no local credential was substituted to impersonate a pipeline
release. No remote migration-list operation was used to initialize a ledger in the
new empty production database.

## Upstream terms, geography and provenance

Primary terms were reviewed on 2026-10-25 and reassessed against the operator's
confirmed private, single-user, noncommercial use and US residency. The earlier
blanket permission findings were too restrictive: hosting, history and a private
dashboard are not themselves commercial distribution. Specific API instructions
support Kraken's restored spot/funding/basis collection. Deribit's personal-use
exception applies to data processing, but US residency separately prohibits access.

The operator subsequently accepted the documented private personal-analysis
interpretation for OKX and authorized the narrow CoinGecko termination-retention
exception. Both adapters are restored in the working tree; attribution is present.
No backup is deleted now, and future production remediation still needs specific
approval of a scoped plan. The backup client remains append-only.

The [data-rights review](BITCOIN-SIGNALS-DATA-RIGHTS.md) records the three requested
categories, clauses, strongest personal-use readings, ambiguities, quotas,
provenance and suitable alternatives. Six automatic providers are enabled;
Deribit remains disabled. No new provider, plan, service, secret, geolocation proxy
or restriction bypass was added.

The final enabled-only local probe at **2026-10-25T23:21:17.213Z** parsed **164 real
observations** from **6 successful sources**: OKX 102 (current/history/spot/index),
Kraken Futures 4 (funding and a dated future), Kraken spot 1, Coinbase 1,
mempool.space 3 and CoinGecko 53 (three totals and 50 company rows). There were no
D1 writes or notifications in that parser probe. This is not production scheduling
or retained production history. A prior Kraken-only restoration probe parsed nine
rows successfully at 23:12:18Z.

The earlier seven-provider local probe is historical diagnostic evidence only;
it conferred no rights, wrote no D1 data and is not a production dataset. At
**2026-10-25T20:35:09.755Z**, the follow-up live probe called **only** the two
enabled providers: Coinbase produced one observation and mempool.space three
(**four total**), all parsed successfully with no D1 writes. No provider that remained disabled was contacted for further measurements after its policy decision.

The persistent local Signals observation inventory was also read: **zero rows**.
The new production database has zero tables, so it contains no prior test data.
Synthetic test rows remain inside ephemeral/isolated local test storage, and
reporting filters additionally quarantine any restricted history found in a legacy
store. They preserve append-only rows and suppress old source-derived alerts;
nothing is imported into production, and no stored backup is deleted or rewritten.

## Provisioning and release state

The authorized command ran after a read-only inventory confirmed absence:

```sh
npx wrangler d1 create cflab-bitcoin-signals --config wrangler.jsonc --binding BTC_SIGNALS --update-config false
```

Cloudflare creation: **2026-10-25T20:13:12.674Z**, account
`b1aa310aa0a1638d72b8b086a21e557c`, region **ENAM**, UUID
**`7630355d-eae7-4410-aef5-7a0486ddc523`**. `wrangler d1 info` verifies the name,
UUID, zero tables, and 12,288-byte empty database. No production migration or seed
was applied. Wrangler rewrote the local config formatting despite the command's
flag; formatting was normalized and semantic equality checked. No other binding,
route, secret, gate or production resource was changed.

| Binding | Verified configured/live UUID | Current tables |
| --- | --- | --- |
| `DB` / `cflab` | `cb2d2eb4-2817-4581-8e50-d69212650adf` | 12 |
| `ANALYTICS` / `cflab-analytics` | `54e8af8e-3345-40e7-88fd-462a688421b5` | 16 |
| `BTC_SIGNALS` / `cflab-bitcoin-signals` | `7630355d-eae7-4410-aef5-7a0486ddc523` | **0; migration pending** |

`wrangler.jsonc` is authoritative for the new production UUID; backup manifests
and restore-target protection derive it. Local IDs intentionally stay local.
The existing release/backup gates were found `true` and preserved. No implementation
commit, new GitHub Actions run, push or release was performed. Both live Workers
still report **`210aad9e0daf1f59654dd02547cdcd6b6ccdd1fb`**, exactly committed
`main` (`verify-drift.mjs`: in-sync). Existing production boundary/projection/
Analytics probes passed in the initial review; new Signals routes are undeployed.

The operator authorized only database creation as a production mutation. Next
release steps therefore remain conditional: resolve the coverage/audience findings,
confirm required CI token scopes and the full release preflight, fetch/reconcile
`main`, then commit/push only when release is authorized and audit blockers are
resolved. Only GitHub Actions may apply approved migrations and deploy. After that,
verify both revisions and real membership boundaries, observe hourly and daily cron
runs, compare dashboard/admin results with D1, prove persistence across runs, and
verify no unexpected mail. A manual refresh is not proof of scheduled execution.

## Isolated restore evidence and remaining blockers

A fresh **local-only** migration-seed roundtrip with the revised source defaults
passed: **13 tables, 18 seed/ledger rows**, matching row hashes/counts and schema
hash, `quick_check=ok`, zero foreign-key violations. Artifact SHA-256:
`5bcb04368ea7a09537707bf9df2a11bcb3d2e752208c7b99a777001125a95f25`.
Schema hash:
`fa389e72f7d0ddd01c02412b26ac1e4750e53136ca77abb6de44e2c6e41385bd`.
This is not a production backup or collection result.

A read-only live backup-bucket check using the documented existing backup
credentials covers all three database names. Primary and Analytics backups are
**fresh** (about 16.7 hours old at the check); Signals is correctly **missing**,
with no malformed manifests reported. No backup was uploaded, overwritten or
removed. The new empty, unmigrated database cannot yet provide a meaningful
schema/data export. After authorized pipeline migration, independently export
`BTC_SIGNALS`, validate the artifact/manifest hashes, restore only into isolated
storage, verify schema/row counts/integrity, and confirm three-database freshness.

Local evidence:

- `/private/tmp/bitcoin-signals-provisioning.log` and `bitcoin-signals-provisioned-info.json`
- `/private/tmp/bitcoin-signals-resource-preflight.json` and `bitcoin-signals-final-preflight.log`
- `/private/tmp/bitcoin-signals-final-check.log`
- `/private/tmp/bitcoin-signals-local-inventory.json` and `bitcoin-signals-permitted-probe.json`
- `/private/tmp/bitcoin-signals-policy-roundtrip-6Y4MtV/report.json`
- `/private/tmp/bitcoin-signals-final-backup-status.json` and `bitcoin-signals-final-drift.log`

**Resolved decisions and remaining release conditions:**

1. **Provider decisions resolved for the intended private use:** OKX/Kraken
   funding/basis and CoinGecko treasury are restored under documented personal-use
   interpretations. CoinGecko's narrow conditional-retention exception is recorded
   in AGENTS.md; no production deletion or backup-policy change was performed.
   Deribit remains disabled for US residency, without blocking the restored
   funding/basis coverage. Licensing interpretations are not provider guarantees.
2. **Audience resolved:** the operator confirmed a single personal administrator
   account. No commercial license is presumed merely from hosting/memberships;
   outside distribution is not authorized by this review.
3. **Requirements traceability:** the separately requested implementation completion
   report/original detailed brief was not supplied, so conformity beyond the task
   and repository documentation remains unverified.
4. **Release preflight/authorization:** verify the actual CI credential scopes and
   migration decision in the authorized pipeline. Creation does not authorize
   credentials, migrations, deployment or a push that triggers release.
5. **Post-release evidence:** production scheduled collection statistics, retained
   observations across runs, authenticated dashboard/admin health, independent
   production backup/restore and three-database backup freshness are still pending.

**Production is not complete.**

## Personal-use review artifacts

The current complete-suite log is
`/private/tmp/bitcoin-signals-restored-full-check.log` (550 passing tests); local
migration/build/preflight logs use the same `bitcoin-signals-restored-` prefix.
The enabled-only real-data probe is
`/private/tmp/bitcoin-signals-restored-probe.json`. New funding/basis reporting
coverage is tested through the real D1 query path, not only parser fixtures.
The existing local database migration ledger had no pending migrations; fresh
test databases also applied the current initial schema with the six permitted automatic providers enabled.
No production collection, authenticated dashboard session, fresh production
Signals backup or GitHub validation run is claimed by these local checks.

## Final real-data persistence and restore drill

At **2026-10-25T23:30:13.501Z**, the final isolated local D1 drill made nine
bounded upstream requests through the production transport/parser/collector code.
Hourly collection succeeded with **111 retained observations**; daily CoinGecko
collection succeeded with **53**. Cached repeats at the same collection clock
added **zero** observations and left the complete observation-row hash unchanged:
`80b2168b1be87263f133a9345cbcffaa9721088df8d79aadb84a959ebf9fa433`.
The real D1 read models returned two funding venues, one dated-basis contract and
11 indicators. These are genuine private research observations, not fixtures.
The repeat uses identical captured responses to test idempotence; it is not a claim
that later independent upstream measurements must deduplicate to the same rows.

The runtime was disposed and the durable isolated store reopened in a separate
process. A single-request table snapshot was dumped using the repository's
serialization, hash and structural validators, then restored using
`restoreAndVerify` into a second isolated local Wrangler database. All **13 tables
and 198 rows** matched, including **164 observations**. Schema and row hashes
matched, `quick_check` was `ok`, and foreign-key violations were zero. The strict
export verifier initially rejected the harness's missing migration ledger; the
harness recorded the migration it had actually applied before retrying. No
verification rule was weakened.

Artifact SHA-256:
`b5bfede138d4df7eb1958c784a0960fda7d7814cc56ae65b3292ddc69e3f0a7b`

Schema SHA-256:
`19c53a7d8cd2371c8de1148df8257ea38637cfa9eae189ae7c6c6699b75b3a24`

Reports/artifacts: `/private/tmp/bitcoin-signals-real-drill-yNAlBQ/`, with
`report.json`, `restore-report.json`, `artifacts/` and `restore/`. The backup
manifest explicitly identifies an isolated LOCAL drill and the local database ID;
it is not a production backup and was not uploaded. Notifications were disabled;
this real-data drill passed `skipAlerts: true`, with zero alert/delivery rows and
no email binding. Alert evaluation/deduplication is exercised separately in the
complete passing local suite.

The normal development store's legacy source flags were reconciled locally with
the authorized policy; it still has zero observations. Its existing migration
ledger was preserved. No production registry or history was changed. Full-suite
validation is **550 tests passing**, plus all three local migrations, both dry-run
builds, `git diff --check` and **35/35** configuration preflight checks. Existing
read-only live resource checks matched all three configured database identities.

Production migration, commit/push/CI release validation, authenticated production
read-model checks, scheduled collection across real production runs, an independent
production Signals backup/restore, and fresh backup reporting for all three
production databases remain pending. The separate completion report/original
brief remains unavailable, limiting requirements traceability. No deployment is
claimed and the release gate is unchanged.
