# CFLab analytics

Analytics is a **second, independently deployable Cloudflare Worker** in this repository. CFLab remains the human identity/authentication authority; analytics never stores users, passwords, or sessions. The two Workers share the existing `cflab-analytics` D1 database, and the dependency is one-way: analytics calls CFLab for session validation, CFLab never calls analytics.

```text
cflab.aismallbizguru.com            analytics.aismallbizguru.com
        │                                      │
        ▼                                      ▼
   CFLab Worker  ◄── HumanAuthService ──  Analytics Worker
   (identity,         (service binding)    (collector, reports,
    operational D1,                        dashboard, cron)
    private R2)                                  │
                                                 └── cflab-analytics D1
```

Legacy collection stays compatible: the most specific zone routes send `lab.aismallbizguru.com/api/analytics/collect*` and `cflab.aismallbizguru.com/api/analytics/collect*` directly to the Analytics Worker, while every other `lab.` path still routes to CFLab. The old CFLab reporting routes (`/api/analytics/summary|timeseries|pages|referrers|recent`) remain in place temporarily and read the legacy tables that the Analytics Worker continues to dual-write.

## Deployments

| Component | CFLab | Analytics |
| --- | --- | --- |
| Worker | `cflab` (`src/index.ts`) | `cflab-analytics` (`src/analytics/index.ts`) |
| Config | `wrangler.jsonc` | `wrangler.analytics.jsonc` |
| Hostname | `cflab.aismallbizguru.com`, `lab.aismallbizguru.com/*` | `analytics.aismallbizguru.com`, plus `lab.`/`cflab.` collect routes |
| D1 | `cflab` (`DB`) | `cflab-analytics` (`ANALYTICS`) |
| R2 | `cflab-files` (`FILES`) | none |
| Static assets | none | `analytics-ui/` |
| Cron | none | hourly at `:17` for rollups and retention |
| Service binding | none | `CFLAB` → `cflab#HumanAuthService` |

## Site model

The hand-maintained site list and origin allowlist are replaced by real tables:

- `analytics_sites`: integer id, immutable opaque `public_id` (`as_` + 22 base62 chars), optional `legacy_key`, `slug`, name, timezone, active flag, privacy/retention settings, creator, timestamps.
- `analytics_domains`: hostnames per Site (`primary`/`alias`), unique per Site, deactivatable. Hostnames are not globally unique.
- `analytics_site_memberships`: `(site_id, user_id)` with `owner`/`editor`/`viewer`. `user_id` references a CFLab user; there is no analytics users table.
- `analytics_event_names`: per-Site registry that caps automatic custom event names at 100.

Existing deployed IDs are preserved as `legacy_key`:

| legacy key | public tracking ID | primary domain |
| --- | --- | --- |
| `junkdrawer` | `as_i5CfW5DyIwS3Zd0prGvRkF` | `hmarquardt.github.io` |
| `top-hat-ferals` | `as_Nrpoc6cKB5afip6oykD2Ab` | `tophatferals.com` |

Legacy `allowed_origins` were mapped to domains; `www.tophatferals.com` and `hmarquardt.github.io` are aliases.

## Raw event model

One table, `analytics_events`, stores pageviews (`event_kind = 'pageview'`, `event_name = 'pageview'`) and custom events (`event_kind = 'event'`). Rows carry `site_day` (calendar date in the Site timezone), the resolved `domain_id`, anonymous `session_id` (optional), pathname only, referrer host only, UTM fields, coarse browser/OS/device, Cloudflare country/region, and constrained `props_json`. `UNIQUE(site_id, event_uid)` deduplicates retried events. Indexes cover site+time, site+domain+time, site+name+time, and site+day.

Properties are shallow JSON: at most 10 keys, key pattern `^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$`, string values at most 200 characters, numbers must be finite, booleans allowed, serialized size at most 2 KiB. Nested objects and arrays are rejected. No EAV table, no automatic property dimensions.

## Privacy

By default the collector stores no cookies, no persistent visitor identifier, no fingerprint, no full IP address, no raw User-Agent, no page content/DOM/form data, no precise location, no query string, and no full external referrer URL. It derives only coarse values. The tracking script keeps its random anonymous session ID in `sessionStorage` only and rotates it after 30 minutes of inactivity; the dashboard reports **Sessions**, not unique humans. DNT and GPC are honored per Site (`respect_dnt`, `respect_gpc`); suppressed requests receive `204 No Content` and store nothing. A source IP may be used transiently as a rate-limit key input but is never written to analytics storage. Legacy dual-write rows preserve the pre-existing legacy table behavior until the old dashboard is retired.

## Collector

Canonical snippet (served from the Analytics Worker, no cookies, no dependencies):

```html
<script defer src="https://analytics.aismallbizguru.com/script.js" data-site="as_i5CfW5DyIwS3Zd0prGvRkF"></script>
```

Canonical endpoint: `POST https://analytics.aismallbizguru.com/collect`

```json
{
  "site": "as_...",
  "kind": "pageview | event",
  "name": "pageview | signup",
  "path": "/pricing",
  "session": "s_...",
  "event_uid": "e_...",
  "referrer": "https://example.com/article",
  "utm": { "source": "newsletter", "medium": "email", "campaign": "fall" },
  "props": { "plan": "pro" }
}
```

Processing order: content type and 8 KiB body limit → strict JSON parse → Site resolution by public ID or legacy key → active check → DNT/GPC → Origin hostname to an active domain of that Site → bot drop → rate limit → event name validation and registry → property validation → session/path/referrer/UTM sanitization → derived browser/OS/device and Cloudflare geography → `INSERT OR IGNORE` → `204`.

Responses disclose as little as practical: unknown or inactive Sites and duplicates return `204`; invalid origins return `403`; malformed input returns `400`; oversized bodies `413`; rate limits `429`. Bots are dropped silently. Domain checks are configuration/error protection, not authentication — an arbitrary HTTP client can spoof `Origin`, and no secret token is embedded in the browser collector.

Legacy endpoint: `POST /api/analytics/collect` (also `https://lab.aismallbizguru.com/api/analytics/collect`) accepts the deployed payload unchanged and returns `200 {"ok": true}`. It records the new model and dual-writes the legacy `visitors`, `sessions`, `pageviews`, and `events` tables. Legacy event types `event` and `custom` are both accepted. Source attribution for this path is instrumentation integrity only (Origin/Referer are spoofable): it uses the first well-formed source — `Origin`, then the payload's `page.host`, then `Referer` — and requires it to be an active domain of the Site. A request with no usable source returns `200 {"ok": true}` without recording; a present but unregistered source returns `403`. It never defaults to the Site's primary domain.

## Authentication and roles

Analytics validates `cflu_` bearer sessions through the narrow CFLab service-binding RPC `HumanAuthService.verifyHumanSession(token)`, which returns only `{ userId, isAdmin }` or `null`. Authorization is `global CFLab admin OR analytics_site_memberships`:

- `owner`: Site settings, domains, memberships, reports;
- `editor`: reports plus snippet/instrumentation access;
- `viewer`: reports only.

Site creation is restricted to global CFLab admins for this MVP; created Sites are owned by the creating admin. Non-members receive `403`; unknown Sites `404`. Browser sign-in for the dashboard uses the normal CFLab `/api/auth/login` endpoint; migration `0008_analytics_dashboard_origin.sql` registers `https://analytics.aismallbizguru.com` as a CFLab app origin for that CORS allowance only.

## API

All private routes require a CFLab bearer session and live under `https://analytics.aismallbizguru.com/api/...`:

```text
GET    /api/health
GET    /api/sites
POST   /api/sites                              (global admin)
GET    /api/sites/:site
PATCH  /api/sites/:site                        (owner)
GET    /api/sites/:site/domains
POST   /api/sites/:site/domains                (owner)
DELETE /api/sites/:site/domains/:domain        (owner, deactivates)
GET    /api/sites/:site/snippet                (editor+)
GET    /api/sites/:site/members                (owner)
PUT    /api/sites/:site/members/:userId        (owner)
DELETE /api/sites/:site/members/:userId        (owner)

GET    /api/sites/:site/summary
GET    /api/sites/:site/timeseries?bucket=day|hour
GET    /api/sites/:site/pages
GET    /api/sites/:site/referrers
GET    /api/sites/:site/campaigns
GET    /api/sites/:site/devices
GET    /api/sites/:site/geography
GET    /api/sites/:site/events
GET    /api/sites/:site/recent
GET    /api/sites/:site/live
```

`:site` accepts the opaque public ID, the legacy key, or the slug. Reports accept `from`, `to` (calendar dates in the Site timezone; default last 7 days) and `domain` (registered hostname). Day buckets use `site_day`; hour buckets are UTC. `live` is a five-minute window (`events`, `pageviews`, `sessions`, active pages); the dashboard polls it every 15 seconds. No WebSockets, Durable Objects, or heartbeats are involved.

## Dashboard

`analytics-ui/` is served by the Analytics Worker at `https://analytics.aismallbizguru.com/`: plain HTML/CSS/JS modules, no framework, no external origins. It signs in with a CFLab account and is organized as product views rather than an administration screen:

- **Overview** (default): KPI row (pageviews, sessions, events, pages/session), a time-series chart with Pageviews/Sessions/Events switching, top pages, referrers, devices, browsers/OS, recent activity, and the live view. Previous-period deltas are computed from a second summary request; when the previous period has no data the delta is omitted rather than invented. New Sites show a "No analytics yet" state that links to Settings.
- **Pages**: page/path report with pageviews, sessions, and share of total.
- **Acquisition**: referrers, aggregated sources, and source/medium/campaign rows.
- **Events**: custom event totals with share, plus recent custom events.
- **Settings**: General, Tracking (snippet + copy), Domains, Privacy & retention, and Access, gated by the viewer/editor/owner role.

The global header carries the Site, Domain, and date-range selectors plus the account controls; Site/Domain/range/tab are persisted in the URL (`?site=&domain=&range=&tab=`), and tab data is fetched lazily. Charts use a locally vendored Chart.js UMD build (`analytics-ui/vendor/chart.umd.js`, pinned via `npm run vendor:chart`; `npm run verify:chart` fails CI if the vendored file drifts from `node_modules`). No CDN or third-party runtime requests are used. A strict CSP is applied through `analytics-ui/_headers`.

Dashboard logic is split into `lib.js` (pure helpers), `ui.js` (DOM rendering), `charts.js` (Chart.js wrapper), and `analytics.js` (state, routing, API). `npm run test:ui` runs Node tests with happy-dom covering ranges, deltas, request URLs, tab/site/domain/range switching, loading, empty, error, session-expiry, and snippet-copy behavior.

## Retention and rollups

Raw retention defaults to 90 days per Site (`raw_retention_days`, 1–3650). The hourly cron:

1. rebuilds `analytics_daily_site`, `analytics_daily_domains`, `analytics_daily_pages`, `analytics_daily_referrers`, and `analytics_daily_events` for the last three days;
2. rolls up any expired days that still have raw rows (at most 10 per run; purge is deferred if more remain, so nothing is deleted before it is aggregated);
3. deletes expired raw events in bounded chunks of 2,000 (up to 10 chunks per Site per run).

`summary` and day-bucket `timeseries` combine retained raw events with daily aggregate totals when a range reaches past raw retention, so long-range trends survive deletion. Other reports are raw-window based by design.

## Migration and backfill

`migrations-analytics/0002_sites.sql` is additive and production-safe: it creates the new tables, seeds the two known legacy Sites with stable public IDs, maps `legacy_key` and domains, and backfills `analytics_events` from legacy `pageviews`/`events` rows collected since the CFLab cutover. Legacy tables are not dropped. No historical pre-CFLab data is recovered, matching the existing cutover decision.

## Deployment

```sh
# 1. Apply migrations (operational origin, then analytics schema)
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
npx wrangler d1 migrations apply ANALYTICS --remote --config wrangler.analytics.jsonc

# 2. Deploy CFLab first so HumanAuthService exists
npm run typecheck && npm test
npx wrangler deploy --config wrangler.jsonc --no-x-provision

# 3. Deploy Analytics
npx wrangler deploy --config wrangler.analytics.jsonc --no-x-provision

# 4. Verify
curl --fail --silent https://analytics.aismallbizguru.com/api/health
# {"status":"ok","service":"cflab-analytics"}
curl -s -o /dev/null -w '%{http_code}\n' https://analytics.aismallbizguru.com/api/sites   # 401
```

Manual Cloudflare steps still required:

- The `analytics.aismallbizguru.com` custom domain must be free (no existing CNAME/DNS record). Wrangler creates the DNS record and certificate on deploy.
- Confirm no wildcard route on the zone intercepts `analytics.` before the specific collect routes; Cloudflare matches the most specific route, so `lab.../api/analytics/collect*` wins over `lab.../*`.
- No separate D1/R2 creation is needed; `cflab-analytics` already exists.

Local development: `npm run dev` (CFLab) and `npm run dev:analytics` (Analytics). The service binding resolves to the locally running CFLab dev instance (both entrypoints export `HumanAuthService`); if CFLab is not running, private analytics APIs return `503 auth_unavailable`. To preview the dashboard locally, temporarily point the `cflab-auth-base` meta tag in `analytics-ui/index.html` at the local CFLab origin (for example `http://127.0.0.1:8787`) and add that origin to the `connect-src` directive in `analytics-ui/_headers`; restore both before deploying. The production CSP intentionally allows only `'self'` and `https://cflab.aismallbizguru.com`.

## Rollback

- **Analytics Worker:** `npx wrangler rollback <version-id> --name cflab-analytics --config wrangler.analytics.jsonc`.
- **Routing:** remove the Analytics `routes` entries and redeploy; `lab.`/`cflab.` collect paths return to CFLab's legacy collector, which still exists and still writes the legacy tables. New-model tables and aggregates remain untouched.
- **CFLab:** the only CFLab changes are an additive named entrypoint and migration 0008 (an app origin row). Roll back the Worker version if needed; the migration is harmless to keep.
- **Data:** migrations are additive; legacy tables and new tables can coexist indefinitely. Do not delete `analytics_events` or the daily aggregates while deciding.

## Intentionally deferred

No Kafka/ClickHouse/BigQuery, no second repository, no second auth system, no duplicated user database, no per-Site collector domains, no session replay/heatmaps/fingerprinting, no consent platform, no enterprise RBAC, no Redis/KV/Durable Objects/Queues, no R2/Parquet lake, no ORM, no frontend framework, and no true realtime infrastructure. Historical pre-CFLab analytics remains an archival decision.

**Compatibility retirement gate.** Keep the legacy CFLab `/api/analytics/*` reporting routes, the legacy analytics tables, the legacy collector dual-write, the `lab.` collector hostname, and the old Junk Drawer dashboard in place until all of the following hold:

1. the new dashboard at `https://analytics.aismallbizguru.com/` has run successfully;
2. existing Sites (Junk Drawer, Top Hat Ferals) are verified with current data;
3. approximately 7 days of side-by-side observation have passed;
4. there is no unexplained material metric divergence between the old and new dashboards.

Only then may the legacy dual-write be retired, and only after that may the old CFLab reporting endpoints be retired. The legacy collector URL may remain indefinitely even after both: its ongoing cost is low and forgotten deployed snippets may still depend on it.
