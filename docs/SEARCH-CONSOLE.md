# Google Search Console integration

CFLab Analytics collects Google Search Console performance data server-to-server
with the existing service account, stores it in the `cflab-analytics` D1 database
next to (never inside) first-party analytics, and shows it on the **Search** tab
of `https://analytics.aismallbizguru.com`.

```text
Google Search Console APIs
        │  service-account JWT  →  access token (read-only scope)
        ▼
Analytics Worker (cflab-analytics)  ── hourly cron :17 ──►  gsc_* tables (D1)
        │                                                     │
        └── /api/sites/:site/search/*  ◄── dashboard Search tab
```

There is no second service, no separate scheduler, no OAuth consent flow, and no
Google script on any public site.

## Properties and Site mapping

The authoritative property list is
[`src/analytics/gsc-properties.ts`](../src/analytics/gsc-properties.ts). It is a
reviewed constant, not a discovery result: an API request can never widen what
CFLab reads, and a newly accessible Google property does not appear until it is
mapped here.

| Property | Analytics Site slug | Status |
| --- | --- | --- |
| `sc-domain:aismallbizguru.com` | `aismallbizguru` | mapped |
| `sc-domain:roadnaturalist.com` | — | collected, no Site registered |
| `sc-domain:hankmarquardt.com` | — | collected, no Site registered |
| `sc-domain:turkeyvulturesoftware.com` | `turkeyvulturesoftware` | mapped |
| `sc-domain:worthlookingup.com` | `worthlookingup` | mapped |
| `sc-domain:fruitingforecast.com` | `fruiting-forecast` | mapped |

All six were verified on 2026-10-27 with `siteRestrictedUser` permission. The two
unmapped properties are still collected, retained and reported by
`GET /api/gsc/status`; their data is simply not shown under a Site.
`GET /api/gsc/status` separates `unmapped` (deliberately no Site) from
`unresolved` (a reviewed `siteSlug` that does not exist in `analytics_sites`),
so a typo or a renamed slug is visible instead of silently hiding data. The
slugs above are the real production values; `fruiting-forecast` contains a
hyphen. To map one,
create the Analytics Site with that slug (`New site` in the dashboard, or
`POST /api/sites`) and the next collection links it — no code or credential
change and no backfill restart, because rows are keyed by property. Renaming a
Site's slug does not detach an already linked property: the stored link is kept
and the property stays visible on that Site.

## What is collected

For every property, every reportable day, with `searchType: web`:

| Report | Dimensions | Stored in |
| --- | --- | --- |
| Property totals | `date` | `gsc_daily_totals` (clicks, impressions, CTR, position, data state) |
| Top queries | `date, query` | `gsc_query_daily` |
| Top landing pages | `date, page` | `gsc_page_daily` |
| Devices | `date, device` | `gsc_breakdown_daily` (`dimension = 'device'`) |
| Countries | `date, country` | `gsc_breakdown_daily` (`dimension = 'country'`) |

**Totals are fetched independently from the query and page reports.** Google's
Search Analytics API is explicitly bounded and returns top rows, not every row;
the date-only report is the only complete total. Query, page and breakdown tables
are therefore never summed to produce a property total, and the dashboard never
does so either.

CTR is stored as a fraction and average position as a rank. Aggregates over a
range are computed from the stored daily rows: `SUM(clicks) / SUM(impressions)`
for CTR and an impression-weighted position, never an average of daily ratios.

### Freshness and provisional days

Requests use `dataState: all`, and Google's own `metadata.first_incomplete_date`
decides what is provisional: a day at or after that marker is stored as
`provisional`, every earlier day as `final`. Only when Google omits the marker
does the documented 2-3 day processing delay decide. Each daily run re-collects
the last seven reportable days, so a provisional day is replaced with its
finalized values automatically.

A stored row with zero clicks and zero impressions means **Google reported no
search traffic for that day**. A day with no row at all was **never collected**,
and the API reports it as `missing_days` instead of pretending it was zero.

## Scheduling and recovery

The collection runs inside the Analytics Worker's existing hourly cron
(`17 * * * *` in `wrangler.analytics.jsonc`); no second scheduler was added.

| Behaviour | Value |
| --- | --- |
| Newest day requested | today − 1 (UTC); today is never requested |
| Daily reconciliation | last 7 reportable days, at most once per 20 hours |
| Backfill chunk | 30 days per run, from the day before the reconcile window |
| Retention floor | 480 days (Google publishes roughly 16 months) |
| Lease | one run at a time, 10 minute TTL, expired leases are taken over |
| Retries | 3 attempts per request for timeouts, 429 and 5xx only |
| Rows per report | 1,000 per page, 3 pages maximum, truncation recorded |
| Google requests per run | 180 maximum, 240 s wall clock maximum |
| Manual runs | administrator only, 4 per hour |

The controller is deliberately small: if the daily pass is due it runs
`full` (reconcile + one backfill chunk); otherwise an incomplete backfill
advances one chunk per hourly run. A transient API, network or storage failure
does **not** advance the daily clock, so the next hourly run retries it, while a
property Google no longer lists (a permission change) is recorded without
re-spending the whole property budget every hour. A complete 16-month backfill
therefore takes ~16 hourly runs, not 16 days.

Re-running is always safe. Each window is written in one D1 batch as
*replace* (delete the window, insert the authoritative rows), so a repeated run
cannot double count and a query that drops out of Google's top rows disappears
instead of lingering as a stale row.

### Failure classes

`authentication`, `access` and `API` failures are never reported as empty data:

| Code | Meaning |
| --- | --- |
| `not_configured` | `GSC_SERVICE_ACCOUNT_JSON` is not installed |
| `invalid_service_account` | the secret is not a usable service-account JSON |
| `google_token_rejected` / `google_token_invalid` | Google refused the JWT exchange |
| `google_sites_rejected` / `google_sites_invalid` | property discovery failed |
| `property_not_accessible` | discovery succeeded but this property is not in the list |
| `access_denied` | the API rejected the token for this property (401/403) |
| `rate_limited` | 429 after the retry budget |
| `upstream_error` | 5xx or an unexpected status after the retry budget |
| `invalid_request` / `invalid_response` | Google rejected the query, or the body could not be read |
| `request_timeout` / `network_error` | the request never completed |
| `storage_failed` | the property could not be registered in D1 |

An empty Google response is not in that table: it is recorded as `empty`, the
days are stored as reported zeros, and the run counts as successful.

## API

Site-scoped (any role on the Site, `:site` accepts the public ID, legacy key or
slug):

```text
GET /api/sites/:site/search/status
GET /api/sites/:site/search/summary?from&to&property
GET /api/sites/:site/search/timeseries?from&to&property
GET /api/sites/:site/search/queries?from&to&property&limit
GET /api/sites/:site/search/pages?from&to&property&limit
GET /api/sites/:site/search/breakdowns?from&to&property&limit
```

Administrator only:

```text
GET  /api/gsc/properties   connectivity probe (existing behavior)
GET  /api/gsc/status       all six properties, mapping, coverage, last sync
POST /api/gsc/sync         bounded manual run; {"scope":"daily"|"backfill"|"full"}
```

`property` is optional and must belong to the requesting Site; an unknown or
foreign property is rejected with `400`. `from`/`to` default to the last 30
reportable days, and a range longer than the 480-day retention window is
rejected.

## Data model

`migrations-analytics/0004_gsc_search.sql` adds five tables:

* `gsc_properties` — property registry, explicit `site_id`, last observed
  permission, backfill cursor/completion, last attempt/success/error, coverage.
* `gsc_sync_state` — lease, last run/success, error code, manual-run budget.
* `gsc_daily_totals` — `(property, search_type, report_day)` with clicks,
  impressions, CTR, position, `data_state` (`final`/`provisional`) and
  `collected_at_ms`.
* `gsc_query_daily`, `gsc_page_daily` — top-N rows keyed by
  `(property, search_type, report_day, query|page)`.
* `gsc_breakdown_daily` — device and country rows keyed by
  `(property, search_type, report_day, dimension, value)`.

Rows always carry the originating property, the search type, the report day and
the collection timestamp. Search Console data is never joined into
`analytics_events` or the daily rollups, and the dashboard never adds clicks to
pageviews: Google measures Google's results page and CFLab measures the site.

Only aggregate search metrics are stored. Search Console data contains no visitor
identifiers, and no query string, cookie, IP address or user agent is written.

## Security

* `GSC_SERVICE_ACCOUNT_JSON` is a Worker Secret, read only inside the Analytics
  Worker. The service-account JSON, the signed JWT assertion and the access token
  never appear in an API response, a log line, a D1 row, or client-side
  JavaScript. The dashboard never talks to Google and no Google script is added
  to any public site.
* Every query is an authenticated CFLab human session validated through the
  existing `CFLAB` service binding, plus the existing Site role model. There is
  no new identity authority, no new administrator flag and no bypass.
* `/api/gsc/properties`, `/api/gsc/status` and `/api/gsc/sync` require a global
  CFLab administrator. The manual trigger is limited to four runs per hour, one
  run at a time, with the same request and time budgets as the cron.
* A request can never name an arbitrary Google property, binding, table or SQL
  statement: the property must be one of the reviewed six **and** mapped to the
  requesting Site.

## Dashboard

The **Search** tab (`panel-search` in `analytics-ui/index.html`) uses the same
light-theme components as the other tabs:

* KPI cards for impressions, clicks, CTR (percentage points) and average position
  (places), each with a real previous-period comparison where a prior period
  exists. Nothing is invented when it does not.
* A daily trend chart switching between impressions and clicks, with a data table
  including each day's `final`/`provisional` state.
* Top search queries and top landing pages (clicks, impressions, CTR, position).
* Device and country breakdowns.
* A status card: property, permission, last successful synchronization, newest
  reported day, days collected and backfill progress, plus a property selector
  when a Site has more than one Search Console property.

The hostname (Domain) filter is hidden on this tab because Search Console is
property-level, and the range selector is clamped to the newest day Google has
reported so "Last 7 days" is not silently empty.

### Empty states

| Situation | What the tab shows |
| --- | --- |
| No property mapped to the Site | "No Search Console property is mapped to this Site", and no report request is made |
| Secret not installed | "Search Console credentials are not configured" |
| No successful synchronization yet | "Waiting for the first synchronization" |
| Last run failed | "Search Console synchronization failed" with the recorded error code |
| Collected, Google reported zero | "No search traffic reported for this period", plus the reported zeros |
| Request failed | A retryable error block in the affected card only |

A newly connected property legitimately reports nothing for a while: Google
starts reporting after the property is verified and indexed, and the collector
stores the reported zeros as `empty`, not as a failure.

## Observability

Each run writes one `console_job_runs` row (`job = 'analytics-search-console'`)
with the scope, request count, day count and per-property outcome, and one
structured log line (`event: "gsc_collection"`) with counts only. Migration
`0013_search_console_job.sql` registers the job with the operations console
(`/admin/console`), which reads the same history and flags it stale after 30
hours. Per-property state lives in `gsc_properties` and is exposed read-only by
`GET /api/gsc/status`.

## Operating it

The cron does the work by itself; a manual run exists only for diagnosis and for
the first sync after a long outage. It never bypasses the lease, the budgets or
the role check.

```bash
# Is the secret installed and can the account see its properties?
# (administrator session; read-only, no data collected)
curl -s -H "Authorization: Bearer $CFLU" \
  https://analytics.aismallbizguru.com/api/gsc/properties

# Mapping, coverage and last sync for all six properties
curl -s -H "Authorization: Bearer $CFLU" \
  https://analytics.aismallbizguru.com/api/gsc/status

# Bounded manual run
curl -s -H "Authorization: Bearer $CFLU" -H 'Content-Type: application/json' \
  -d '{"scope":"full"}' https://analytics.aismallbizguru.com/api/gsc/sync
```

## Local development

`npm run dev:analytics` serves the Worker on loopback with the local D1 database.
Installing a real service-account secret locally is optional: put
`GSC_SERVICE_ACCOUNT_JSON=` (a JSON string) in the Analytics Worker's `.dev.vars`,
apply `npm run db:migrate:analytics`, and the scheduled handler behaves exactly
as in production. Without it the status endpoints report `configured: false` and
no Google request is attempted. Unit tests inject a fake fetcher and a generated
throwaway keypair, so no credential is needed to run them.

## Verification

`npm run check` covers the JWT signature (verified against a generated public
key), token and API error classes, discovery and mapping, pagination and row
limits, empty/provisional/final responses, retries, lease and daily gating,
idempotent rewrites, backfill progress and completion, authorization, and
credential confidentiality. `scripts/verify-production.mjs` probes
`GET /api/gsc/status` unauthenticated and expects `401`; a `404` there means the
release did not include this module.
