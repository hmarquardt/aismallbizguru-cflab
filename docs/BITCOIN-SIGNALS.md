# Bitcoin Signals

Bitcoin Signals is a private research instrument inside CFLab. It is served by the
existing `cflab` Worker at **https://cflab.aismallbizguru.com/bitcoin-signals** and
answers one question with retained, source-attributed measurements:

> Is bitcoin becoming money that businesses, governments, and individuals actually
> hold and use, or is it merely becoming another rail for moving fiat currency?

It is **not** an automated trading system. There is no order placement, no
brokerage integration, no custody of keys, and no composite investment score. A
theoretical annualized carry is labelled indicative and never presented as
guaranteed income. AI analysis is not a dependency of collection, storage,
calculation, or alerting.

## 1. Architecture

| Component | Value |
| --- | --- |
| Worker | `cflab` (`wrangler.jsonc`, `src/index.ts`) — the existing Worker |
| Hostname | `cflab.aismallbizguru.com` (and `lab.aismallbizguru.com` by zone route) |
| Dashboard | `GET /bitcoin-signals` (HTML shell, no data) |
| API | `/api/bitcoin-signals/*` (human session + pinned operator identity) |
| Data | D1 `cflab-bitcoin-signals`, binding `BTC_SIGNALS`, migrations in `migrations-bitcoin-signals/` |
| Identity | primary D1 `cflab`: `apps`, `users`, `project_memberships` |
| Registry | primary D1 `cflab`: `project_storage` (backend + binding + migrations dir) |
| Schedule | hourly `7 * * * *` and daily `41 6 * * *` cron triggers on this Worker |
| Email | the existing `send_email` binding; off until an administrator enables it |
| R2 | not used |

No new Worker, domain, VM, SaaS, identity system, or deployment pipeline is
introduced. The release path is the existing GitHub Actions pipeline.

### Why a separate database

Market history, evidence, and collection logs are append-only research data with a
different retention and backup profile from identity. Keeping them in their own D1
database means evidence can grow, be exported, or be restored on its own without
touching authentication, and an outage or a bad migration in one store cannot
corrupt the other. The administration UI reads the project's identity from the
primary database and its data from `BTC_SIGNALS`.

## 2. Sources and indicators

**Current permission boundary (2026-10-25):** private, single-user,
noncommercial personal research for the US-resident operator. OKX public funding,
settlement history and spot/index, Kraken public spot/Futures, Coinbase spot,
mempool.space and daily CoinGecko treasury reports are enabled in the working tree.
The operator accepted the documented personal-analysis interpretations and the
narrow CoinGecko termination-retention exception in AGENTS.md. Linked attribution
is present. Deribit allows personal data processing but prohibits US-resident
access; it stays disabled, regardless of VPN or Worker location. See the
[data-rights review](BITCOIN-SIGNALS-DATA-RIGHTS.md) for clauses and interpretations.

`src/bitcoin-signals/policy.ts` is authoritative: neither a registry row nor an API
request can enable a disabled provider. Disabled adapters remain available for
synthetic offline tests. Their retained observations and source-derived alerts are
excluded from dashboards, history, calculations, CSV exports, notification evaluation
and administration totals. No retained observation or backup was deleted for this
review. Settings distinguishes disabled sources from stale or failed sources.

Hourly collection restores funding/basis; daily collection restores reported
treasury history. Exports and access remain for the confirmed personal audience;
potential memberships do not authorize redistribution. Access controls, product
restrictions and rate limits must not be bypassed. This review deploys nothing.

The collector only calls the fixed HTTPS endpoints in
`src/bitcoin-signals/sources.ts`. A host outside `ALLOWED_HOSTS` is refused before
a request is made; no request parameter, header, URL, or credential can be supplied
by a caller. Responses are validated field by field against the expected shape and
plausible ranges, with an 8-second timeout and a 1.5 MB body cap. Redirects are
refused by checking the response status (Workers `fetch` only supports `follow`
and `manual`, not `error`), and the content type must be JSON.

The table below describes retained adapter capabilities, not permission to collect.
Earlier local endpoint probes are historical diagnostics only. They were not
imported into production; the current enabled set follows the terms review.

| Source id | Endpoint(s) | Cadence | Tier | What it measures |
| --- | --- | --- | --- | --- |
| `okx` | `/api/v5/public/funding-rate`, `/funding-rate-history`, `/market/ticker`, `/market/index-tickers` | hourly | measured | Current funding (interval read from `fundingTime`→`nextFundingTime`), realized funding history, spot last price, index price |
| `deribit` | `/api/v2/public/ticker?BTC-PERPETUAL`, `/get_instruments`, `/get_book_summary_by_currency` | hourly | measured | `funding_8h`, index, perpetual mark, and the mark of the nearest live dated future |
| `kraken-futures` | `/derivatives/api/v3/tickers` | hourly | measured | Linear `PF_XBTUSD` hourly `relativeFundingRate`, multiplied by 8; index and mark; nearest dated `FF_XBTUSD_YYMMDD` mark |
| `kraken-spot` | `/0/public/Ticker?pair=XBTUSD` | hourly | measured | XBT/USD last trade (no source timestamp: recorded at retrieval and labelled) |
| `coinbase-spot` | `/products/BTC-USD/ticker` | hourly | measured | BTC/USD last trade at the source-reported time |
| `mempool-space` | `/api/v1/lightning/statistics/latest` | hourly | reported | Public Lightning node count, channel count, total public capacity, recorded at collection time with the dataset id and its `added` date as provenance (that field is not a reliable measurement time) |
| `coingecko-treasury` | `/api/v3/companies/public_treasury/bitcoin` | daily | reported | Reported public-company holdings, USD value, market-cap dominance, per-company holdings |
| `curated-research` | — (human entry) | curated | curated | Attributed timeline entries for retention, sovereign settlement, and regulation |

The six signals from the brief map as follows.

| Signal | How it is covered |
| --- | --- |
| 1. BTC treasury holdings | Daily CoinGecko reported aggregate/per-company holdings with attribution; curated primary-filings evidence remains available. |
| 2. Retention versus fiat conversion | Not directly measurable from chain or exchange data. Curated `retention` evidence with an attributed source; the dashboard labels this coverage as curated-only. |
| 3. Lightning adoption | `mempool-space` node/channel/capacity measurements. Capacity and channel count are explicitly **not** payment volume; published payment-volume research is curated as `estimated`/`reported` evidence. |
| 4. International and sovereign settlement | Curated timeline with `status` = proposed / authorized / pilot / effective / activity, so an announcement is never confused with economic activity. |
| 5. Funding and basis arbitrage | OKX current/settled funding and Kraken public Futures funding/nearest dated-future basis, with normalized rates, indicative cost-adjusted calculations and retained history. Deribit remains disabled. |
| 6. Regulation and taxation | Curated timeline with the same stages, `jurisdiction`, and review state. |

### Tiers

`measured` (a direct API reading by CFLab), `reported` (a third party's published
figure, e.g. CoinGecko or mempool.space), `estimated` (a published estimate,
curated), `curated` (a human-entered, attributed source). Every observation row and
every dashboard card carries its tier; the UI never presents a curated or reported
figure as machine-measured.

## 3. Data model and integrity

`migrations-bitcoin-signals/0001_bitcoin_signals.sql` is additive (`CREATE TABLE`,
`CREATE INDEX`, `INSERT OR IGNORE`), so the migration gate can apply it without an
operator approval.

| Table | Role |
| --- | --- |
| `bs_sources` | Source registry: id, homepage, cadence, default tier, measurement definition |
| `bs_collection_runs` | One row per run: job, trigger, status, source counts, observations seen/added |
| `bs_source_runs` | Per-source outcome of a run, with a sanitized error code and message |
| `bs_collection_locks` | One atomic lease per job; prevents overlapping runs |
| `bs_observations` | The retained measurements (append-only) |
| `bs_evidence` | Curated timeline with source, provenance, and review state |
| `bs_hypotheses` / `bs_evidence_hypotheses` | The six hypotheses and their evidence links |
| `bs_alerts` / `bs_alert_deliveries` | Deduplicated alerts and delivery history |
| `bs_settings` | Operator configuration (notifications, thresholds, assumptions) |
| `bs_backup_checks` | Attested readings of the read-only backup verification |

Every observation retains:

| Field | Meaning |
| --- | --- |
| `source_id`, `source_url` | The named source and the exact endpoint the value came from |
| `observed_at` | The measurement time reported by the source; where a source publishes no trustworthy measurement time (Kraken spot, CoinGecko, mempool.space) this is the collection time, labelled `observed_at_source: "retrieval"` in `meta_json` |
| `retrieved_at` | When CFLab fetched it |
| `unit`, `definition` | The unit and measurement definition from the series registry |
| `tier` | measured / reported / estimated / curated |
| `run_id` | The collection execution that inserted it |
| `meta_json` | Provenance detail (raw rate, source interval, instrument, expiry, attribution) |
| `revision` | 1 for a first observation; a correction is the next revision |

The unique key is `(source_id, series, venue, observed_at, revision)`. Collection
uses `INSERT ... ON CONFLICT DO NOTHING`, so re-running a collection is a no-op and
never rewrites retained history. Corrections are new rows; reads select the maximum
revision per `(venue, observed_at)`. There is no `UPDATE` of a measurement.

A failed source cannot damage history: values are validated before any insert, each
source is isolated (one bad payload fails only that source), and a run that fails
completely still records its outcome and leaves previous observations untouched.

## 4. Funding, basis, and carry calculations

Conventions are fixed in `src/bitcoin-signals/market.ts` and unit-tested:

* **One unit.** Every funding rate is stored as a decimal fraction **per 8-hour
  period**. A 4-hour venue is doubled to the same unit; an unsupported interval is
  rejected, never guessed. The source interval is kept in `meta_json`.
* **Annualization.** APR = normalized rate × 1095 × 100. APY compounds the
  source's native periodic rate at its native interval (e.g. 8760 hourly periods
  for Kraken). Negative rates annualize symmetrically: APR is
  negative and APY is negative but smaller in magnitude, because compounding a loss
  is still a loss.
* **Costs.** One-time round-trip cost = (fee bps + slippage bps) × legs. It is
  spread over an explicit holding window (`holding_days`, default 30) to produce a
  cost APR, and deducted from the funding APR. `breakeven_periods` is the number of
  periods needed to recover the cost at the current rate; it is `null` for a negative
  or zero rate.
* **Basis.** For a dated future: (mark / same-venue index − 1) × 100, annualized by
  the exact time from the quote to expiry. Round-trip costs use this same expiry
  horizon, independently of the perpetual holding-window assumption. A contract inside its final 12 hours is refused rather
  than producing a triple-digit percentage from a rounding difference.
* **Staleness.** A quote older than 3 hours is shown but excluded from rankings and
  from threshold alerts.
* **Persistence.** Computed from retained history, deduplicated by observation time:
  sample count, coverage, mean, median, positive and negative share, longest positive
  and negative runs. Only settled history has a cumulative figure, summing actual
  payouts at each source interval; overlapping sampled quotes have no cumulative
  income. Venues with a settled
  funding series (OKX) report `basis: "settled"`; venues without one use collected
  current funding and report `basis: "sampled"`. The dashboard shows which one is in
  use, because a sampled prediction is not settled income.

OKX spot/index prices are USDT per BTC, labelled with that unit; the legacy series
keys ending in `_usd` do not imply a USDT/USD conversion. Deribit's `funding_8h`
is a trailing eight-hour reading, distinguished from a current prediction. OKX
history intervals are derived separately from adjacent exact settlement timestamps;
the first period and unsupported gaps are omitted rather than guessed.

Assumption defaults: 2 bps fee and 1 bp slippage per leg, 4 legs, 30 holding days.
They are stored in `bs_settings['arbitrage.assumptions']`, editable in Settings, and
can be overridden per request. Validation is strict: unknown keys, non-integers, and
out-of-range values are rejected.

## 5. Hypotheses and evidence

Six hypotheses are seeded and shown with **evidence counts only** — supports,
contradicts, mixed, verified, total. There is deliberately no weighted score:

1. `treasury-demand` — Bitcoin treasury demand is increasing.
2. `retained-asset` — Bitcoin is becoming a retained monetary asset.
3. `lightning-commerce` — Lightning is increasing real commercial payment activity.
4. `sovereign-downstream` — Sovereign settlement creates downstream commercial adoption.
5. `stablecoin-substitution` — Stablecoins capture payments without equivalent BTC demand.
6. `carry-persistence` — Funding and basis inefficiencies persist after realistic costs.

Evidence entries require a title, summary, `occurred_at`, a stage
(`proposed`/`authorized`/`pilot`/`effective`/`activity`/`market`), a direction,
importance, and an HTTPS source URL with a source title. The entry stores
`retrieved_at`, a content fingerprint (so a repeat is a `409` rather than a
duplicate), and the human review state. A member with write access can add an entry
and record a review; the reviewer's user id and timestamp are stored.

## 6. Alerts

Four deterministic rules evaluate stored data after each collection:

| Rule | Condition | Dedupe key |
| --- | --- | --- |
| `funding-sustained` | Mean funding over the window ≥ `funding_threshold_bps_8h` with at least `funding_sustained_periods` samples, inside `funding_window_hours` | venue + UTC day |
| `treasury-change` | Reported public-company holdings moved by ≥ `treasury_change_pct` or ≥ `treasury_change_btc` between the two newest daily totals | UTC day |
| `verified-development` | A human verified an evidence entry with importance `high` | evidence id |
| `stale-source` | No successful collection inside `stale_multiplier` × cadence, or `error_streak` consecutive failures; only for a source that has actually been attempted, so a fresh installation is quiet | source + UTC day |

Alerts are stored in `bs_alerts` whether or not email is enabled, so the dashboard
shows them. **Email is off by default** (`alerts.notifications.enabled = false`);
an administrator must set a recipient and enable it in Settings. Each new alert
produces at most one delivery attempt, recorded in `bs_alert_deliveries` as `sent`
or `failed` with a sanitized error code. A duplicate alert is never re-delivered.

## 7. Dashboard

`GET /bitcoin-signals` serves a self-contained page with four sections, inline
CSS/JS (no CDN, no external script, no frontend framework), inline SVG sparklines
drawn from retained points, and a mobile layout where table cells stack under
their `data-label`. The page itself contains no measurements: all data is fetched
with the session credential.

| Section | Content |
| --- | --- |
| **RADAR** | Current indicators per venue with value, unit, tier, observation and retrieval time, staleness, ~7-day change, retained-history sparkline, and the exact source URL and definition. Hypotheses with evidence counts, curated-only coverage, recent alerts. |
| **ARBITRAGE** | Editable fee/slippage/legs/holding assumptions, gross and net annualized funding per venue, dated-futures basis, historical persistence, best eligible venue (stale quotes excluded), and the disclaimer. |
| **EVIDENCE** | Searchable, filterable timeline with stage, direction, importance, review state, hypotheses, source link, and review actions for writers. |
| **SETTINGS** | Project storage backend and reachability, collection health and per-source freshness, alert configuration, backup status and attestation, manual refresh, and CSV export. Administrator-only. |

## 8. Access control

Access reuses CFLab human-session validation against the primary database
(`sessions` → active `users`) and then requires the sole existing operator ID
pinned in `src/projects.ts`, with its administrator role still active. The same
owner check protects `/api/admin/projects/bitcoin-signals/status`. All other
CFLab administration and project semantics are unchanged: the second administrator
retains general privileges but receives `403` for Signals research, even after
ordinary membership grants. Editable email, project configuration, headers, and
membership rows cannot change the pinned identity. No account is deleted or demoted.
Machine `cfl_` app tokens are rejected (`401`). Project identity/storage metadata
in the general admin lists contains no research observations or alerts.

All endpoints below require that owner session; the read/write labels describe
operations, not permission for ordinary project members. No ownership-changing
API, new credential, migration, service or authentication system is introduced.

| Endpoint | Access |
| --- | --- |
| `GET /api/bitcoin-signals/radar` | read |
| `GET /api/bitcoin-signals/arbitrage` | read |
| `GET /api/bitcoin-signals/evidence` | read |
| `POST /api/bitcoin-signals/evidence` | write |
| `PATCH /api/bitcoin-signals/evidence/:id` | write |
| `GET/PATCH /api/bitcoin-signals/settings` | administrator |
| `GET /api/bitcoin-signals/status` | administrator |
| `POST /api/bitcoin-signals/refresh` | administrator |
| `POST /api/bitcoin-signals/alerts/:id/ack` | administrator |
| `POST /api/bitcoin-signals/backup-attestation` | administrator |
| `GET /api/bitcoin-signals/export?dataset=observations|evidence` | administrator |
| `GET /api/admin/projects` | administrator |
| `GET /api/admin/projects/bitcoin-signals/status` | administrator |

`GET /api/admin/projects` lists every project with its backend, binding, and
migrations directory; `GET /api/admin/projects/:app/status` returns the full health
view for Bitcoin Signals and only the storage summary for any other project. There
is no endpoint that names a table, accepts SQL, or returns raw rows for arbitrary
inspection.

## 9. Provisioning

Provisioning the database is a **one-time operator action** outside the pipeline
(the pipeline deploys with `--no-x-provision` and must never create resources).
**Completed with explicit operator authorization:** `cflab-bitcoin-signals` was
created at `2026-10-25T20:13:12.674Z` in ENAM with UUID
`7630355d-eae7-4410-aef5-7a0486ddc523`. The authoritative production binding in
`wrangler.jsonc` records it. Cloudflare reports zero tables: no production schema
has been migrated. Do not create this database again. The historical procedure
below is for reference, not authorization to repeat it.

```sh
# 1. Create the database in the CFLab Cloudflare account.
npx wrangler d1 create cflab-bitcoin-signals --config wrangler.jsonc --binding BTC_SIGNALS --update-config false

# 2. Put the returned id in the single authoritative production entry:
#      wrangler.jsonc  -> d1_databases[].binding == "BTC_SIGNALS" .database_id
# Backup manifests and restore protection read that entry. Keep local IDs local.

# 3. Prove the preflight accepts it (read-only, no production change).
node scripts/ci/verify-deployment-target.mjs --config-only

# 4. Let the pipeline apply the schema (it classifies 0001 as additive) and
#    deploy. Apply nothing by hand against production.
```

The account must be `b1aa310aa0a1638d72b8b086a21e557c`. Obtain explicit operator
authorization before step 1, recheck `wrangler d1 list --config wrangler.jsonc
--json` for an existing resource, and verify the created name/UUID with
`wrangler d1 info cflab-bitcoin-signals --config wrangler.jsonc --json`.
The full deployment preflight additionally checks all three actual Cloudflare
database names/UUIDs using the existing D1 credential. Confirm the migration and
backup credentials cover the third database; do not broaden or replace them
without operator authorization. The deployment and backup gates stay as found.
See [the independent audit](BITCOIN-SIGNALS-AUDIT.md) for current evidence and
remaining release conditions.

After the first release:

* `GET /api/version` reports the released revision for the Worker that serves the
dashboard.
* `node scripts/backup/d1-export.mjs --out backups --database BTC_SIGNALS` then
  `node scripts/backup/restore-verify.mjs --manifest <manifest>` proves the third
  database backs up and restores before the scheduled workflow relies on it.
* The first scheduled collection runs at the next `:07`, or immediately via
  Settings → Refresh (administrator, at most four manual runs per hour).

## 10. Backup, restore, and recovery

The third database has exactly the same guarantees as the other two:

* `scripts/backup/d1-export.mjs` exports it read-only (all table reads in one
request/transaction, single-request snapshot) and writes a manifest with SHA-256,
schema and row hashes, and row counts. A failed snapshot read stops the backup;
* `scripts/backup/restore-verify.mjs` restores it into an isolated local database
and compares schema, row counts, `quick_check`, foreign keys, and row hashes before
anything is uploaded — and refuses production names and ids as a restore target;
* `scripts/backup/backup-status.mjs` fails when any of the three is missing or older
than 30 hours;
* `.github/workflows/restore-drill.yml` drills `cflab`, `cflab-analytics`, and
`cflab-bitcoin-signals` into temporary databases (`mode=prepare` creates nothing;
`mode=execute` needs `confirm=RESTORE-DRILL`);
* `.github/workflows/backup.yml` needs no change: it iterates the manifests.

The Worker has no backup-bucket credential. Settings → Backup status therefore shows
the last **attested** reading of `node scripts/backup/backup-status.mjs --json`,
which an administrator pastes into the attestation form. The Worker recomputes the
verdict from the three per-database statuses, so a claimed `ok: true` cannot make a
stale database fresh. With no attestation it reports `not recorded` rather than
implying a backup exists.
Attestations require each backup's capture timestamp, and freshness expires as
the backups age, even if no new attestation is recorded.

## 11. Scheduling and failure handling

* Hourly at `:07` UTC: permitted active OKX, Kraken spot/Futures, Coinbase and mempool.space sources.
* Daily at `06:41` UTC: CoinGecko reported treasury collection and alert evaluation.
* The lease (`bs_collection_locks`) makes overlapping runs impossible; a scheduled
  run inside the minimum interval is skipped (`interval_not_elapsed`); a crashed run
  releases its lease after 10 minutes.
* Manual refresh is administrator-only and rate-limited to four runs per hour. It
  shares the lease with the schedule.
* Each source failure is recorded with a stable code (`http_503`, `shape`, `value`,
  `network`, `content_type`, `too_large`, `host_not_allowed`, `rejected_observations`)
  and a sanitized message. A partial run is `partial`; a wholly failed run is
  `failed`;
  both are visible in Settings and raise a `stale-source` alert on the next evaluation.

## 12. Tests

| File | What it proves |
| --- | --- |
| `test/bitcoin-signals/market.test.ts` | 8-hour normalization, 1095-period annualization, APY for negative rates, fee/slippage deduction, breakeven, basis annualization and expiry guard, persistence dedupe and runs, interval inference, staleness, strict assumption validation |
| `test/bitcoin-signals/collector.test.ts` | Normalized and fully attributed collection from every source, exact idempotency at the same clock, failure isolation with unchanged history, payload rejection, future/oversized observation rejection, lease, interval, and manual-limit protection, daily job selection, all four alert rules, delivery success and failure, notifications off by default |
| `test/bitcoin-signals/api.test.ts` | 401 for anonymous and machine tokens, 403 for non-members, read vs write vs administrator boundaries, evidence provenance and review attribution, duplicate and invalid evidence rejection, search/filter safety, storage separation, dashboard shell, arbitrage maths through the API, settings validation, refresh, backup attestation, bounded CSV export, administration integration, and unchanged existing administration |
| `test/bitcoin-signals/migrations.test.ts` | All three schemas migrate independently and idempotently, seeds are correct, no `bs_` table exists in the primary or analytics database, no identity table exists in the signals database, the registry row is present, and the backup registry knows three databases |
| `test/ui/bitcoin-signals.test.mjs` | Page structure, mobile viewport and stacked table labels, no external assets or inline handlers, radar rendering with freshness and source evidence, tab switching, assumption recalculation, review actions for writers only, settings including backup status, and the refresh/attestation flow |

## 13. Known limitations

* **Reported, not audited.** CoinGecko treasury figures and mempool.space Lightning
  statistics are third-party aggregations. CFLab records them as `reported` and
  never claims to have verified a filing or counted a payment.
* **Noisy retention evidence.** Retention versus conversion cannot be measured from
  public chain data; it stays curated, and the dashboard says so.
* **Lightning metrics are not payments.** Nodes, channels, and capacity are public
  network state. Payment volume appears only as curated published research.
* **Permission-limited coverage.** OKX/Kraken funding/basis and CoinGecko treasury are
  enabled for personal research under the documented interpretations. Deribit stays
  disabled for US residency; this task adds no provider.
* **Contract conventions.** Deribit is inverse and BTC-settled; its USD carry is
  approximate. Kraken `PF_XBTUSD` is linear and USD-settled with multiple collateral
  options. OKX is USDT-margined; a USD peg is not assumed for stored prices.
* **No composite score, no forecast.** The instrument reports what was measured.

## 14. Operational cost

* Cron invocations: ~775 per month (24 hourly + 1 daily per day), plus dashboard
  reads. They share the existing Worker's included request allowance.
* D1 rows at the current permission boundary: roughly 12 new observations/hour plus
  new settled funding periods, daily treasury totals/company rows, and an initial
  bounded OKX history window (100 returned periods maximum; first interval may be
  omitted if unknown). Repeated history is deduplicated, not reinserted each hour.
  Company counts vary with the reported dataset.
* Email: only when an administrator enables notifications, at the existing Email
  Sending rate.
* No new Worker, R2 bucket, KV namespace, Durable Object, queue, or paid service.
