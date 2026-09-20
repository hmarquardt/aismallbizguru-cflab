# CFLab analytics

## Storage decision

Analytics uses a **dedicated D1 database `cflab-analytics`** (`54e8af8e-3345-40e7-88fd-462a688421b5`), bound to the existing `cflab` Worker as `ANALYTICS`. It is deliberately separate from the operational `cflab` D1 so analytics growth and retention never affect application data.

Why D1:
- the legacy analytics store is SQLite with five relational tables and SQL aggregation queries the dashboard already depends on;
- the dataset is small per day (hundreds of pageviews) and grows linearly; D1 handles this comfortably;
- it keeps one runtime, one Worker, prepared SQL, and no new architecture.

Reconsider the architecture if any of these become true: the analytics store exceeds roughly 5–10 GB, daily inserts exceed D1 write limits, or queries need columnar scans over long ranges. At that point R2 + Parquet with an external query layer is the next step; Workers Analytics Engine is not a suitable sole historical store because of retention limits.

## Schema

`migrations-analytics/0001_analytics.sql` mirrors the legacy schema (`sites`, `visitors`, `sessions`, `pageviews`, `events`) with the same columns and indexes so historical exports can be imported unchanged. Two sites are seeded: `junkdrawer` and `top-hat-ferals`.

Privacy: the collector intentionally does **not** populate `ip_hash`, `user_agent_hash`, or `raw_payload`. Visitor and session identity is the client-generated anonymous ID already used by the collector. The columns remain only for historical import fidelity.

## Collector contract (preserved)

`POST /api/analytics/collect` with a JSON body:

```json
{
  "site_id": "junkdrawer",
  "event_type": "pageview | heartbeat | event",
  "visitor_id": "v_<random>",
  "session_id": "s_<random>",
  "occurred_at": "<ISO timestamp>",
  "page": { "url", "host", "path", "query", "title" },
  "referrer": { "url", "domain" },
  "utm": { "source", "medium", "campaign", "term", "content" },
  "client": { "language", "timezone", "screen_width", "screen_height", "viewport_width", "viewport_height", "user_agent" },
  "performance": { "load_time_ms", "navigation_type" },
  "event_name": "...", "target_url": "...", "value_number": 0, "value_text": "...", "props": {}
}
```

- Path and request shape match the legacy API, so the 72 existing pages that load `analytics-lite.js` with `data-api="https://lab.aismallbizguru.com/api/analytics/collect"` need **zero edits**. Since the 2026-09-20 cutover, both `lab.aismallbizguru.com` and `cflab.aismallbizguru.com` serve this endpoint from the same Worker.
- Validation: known site, site-scoped Origin, event type allowlist, bounded string/number fields, 32 KiB body limit, JSON only, bound SQL.
- CORS: only the exact origins registered per site (`https://hmarquardt.github.io`, `https://tophatferals.com`, `https://www.tophatferals.com`); no wildcard.
- Rate limit: `RL_ANALYTICS` (120 requests/minute per site + hashed client IP).
- Bots are flagged (`is_bot`) from the user agent and excluded from dashboard metrics.
- Collection is fire-and-forget from the page: `analytics-lite.js` uses `sendBeacon`/`keepalive` fetch and never blocks rendering.

## Dashboard contract

Admin-session endpoints (human admin only, no shared secret):

```text
GET /api/analytics/summary?site_id&from&to
GET /api/analytics/timeseries?site_id&from&to&bucket=day|hour
GET /api/analytics/pages?site_id&from&to&limit
GET /api/analytics/referrers?site_id&from&to&limit
GET /api/analytics/recent?site_id&limit
```

Response shapes match the legacy dashboard queries exactly (pageviews/visitors/sessions, bounce rate, bucket points, page and referrer tables, recent visits). The dashboard at `junkdrawer/analytics-dashboard.html` now points at CFLab and signs in with a CFLab admin account; its session lives in `sessionStorage` and a stored legacy LabBox API base is ignored.

## Historical analytics

The legacy analytics database lives on the VM and is only reachable through the legacy dashboard token (not available) or host access (unavailable). **Historical analytics data has not been migrated.** Ongoing collection and dashboard use are fully operational on CFLab.

To complete historical migration later, either:
1. obtain the legacy analytics SQLite file (VM access, or the encrypted Restic archive) and import it with a dry-run-first tool, or
2. authorize a dashboard-token read to export the history.

Until then, treat historical analytics as an archival/recovery item, not a blocker for the hostname cutover: after cutover, new collection lands in CFLab and the dashboard shows CFLab data only.
