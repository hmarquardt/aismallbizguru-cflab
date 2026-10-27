-- Google Search Console search performance (cflab-analytics D1).
--
-- Additive migration. Search Console measurements are kept in their own tables
-- and never merged into `analytics_events` or the daily rollups: clicks and
-- impressions come from Google's sampling/anonymisation pipeline, while
-- pageviews and sessions come from the first-party collector. The dashboard
-- presents them side by side and never sums one into the other.
--
-- Provenance kept per row: originating property, search type, report day, the
-- collection timestamp, and (for totals) whether Google still considers the day
-- provisional. Query, page and breakdown rows inherit the freshness of the
-- matching total row for that property and day.
--
-- `gsc_properties` also holds the explicit property -> Site mapping used by the
-- dashboard. The authoritative list lives in src/analytics/gsc-properties.ts;
-- rows are upserted by the collector so an operator can see mapping state and
-- coverage without a request ever supplying a property name.

CREATE TABLE IF NOT EXISTS gsc_properties (
  property             TEXT PRIMARY KEY,
  property_kind        TEXT NOT NULL CHECK (property_kind IN ('domain', 'url_prefix')),
  hostname             TEXT NOT NULL,
  label                TEXT NOT NULL,
  site_id              INTEGER,
  permission_level     TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  backfill_cursor      TEXT,
  backfill_complete    INTEGER NOT NULL DEFAULT 0,
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  last_error_code      TEXT,
  days_covered         INTEGER NOT NULL DEFAULT 0,
  newest_day           TEXT,
  first_incomplete_day TEXT,
  created_at_ms        INTEGER NOT NULL,
  updated_at_ms        INTEGER NOT NULL,
  FOREIGN KEY(site_id) REFERENCES analytics_sites(id)
);
CREATE INDEX IF NOT EXISTS idx_gsc_properties_site ON gsc_properties(site_id);

CREATE TABLE IF NOT EXISTS gsc_sync_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  lease_owner            TEXT,
  lease_expires_at_ms    INTEGER,
  last_run_started_at    TEXT,
  last_run_finished_at   TEXT,
  last_success_at        TEXT,
  last_error_code        TEXT,
  manual_window_start_ms INTEGER NOT NULL DEFAULT 0,
  manual_runs_in_window  INTEGER NOT NULL DEFAULT 0,
  updated_at_ms          INTEGER NOT NULL
);

-- One row per property, search type and report day, produced by a report grouped
-- by date only. A stored row with zero clicks/impressions means "Google reported
-- no search traffic for this day", which is different from "this day was never
-- collected" (no row at all).
CREATE TABLE IF NOT EXISTS gsc_daily_totals (
  property        TEXT NOT NULL,
  search_type     TEXT NOT NULL DEFAULT 'web',
  report_day      TEXT NOT NULL,
  clicks          INTEGER NOT NULL,
  impressions     INTEGER NOT NULL,
  ctr             REAL NOT NULL,
  position        REAL,
  data_state      TEXT NOT NULL CHECK (data_state IN ('final', 'provisional')),
  collected_at_ms INTEGER NOT NULL,
  PRIMARY KEY (property, search_type, report_day)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_totals_day ON gsc_daily_totals(report_day);

-- Top-N rows only: Google's API is explicitly bounded and does not return every
-- query or page. These tables are never used to compute property totals.
CREATE TABLE IF NOT EXISTS gsc_query_daily (
  property        TEXT NOT NULL,
  search_type     TEXT NOT NULL DEFAULT 'web',
  report_day      TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  clicks          INTEGER NOT NULL,
  impressions     INTEGER NOT NULL,
  ctr             REAL NOT NULL,
  position        REAL,
  collected_at_ms INTEGER NOT NULL,
  PRIMARY KEY (property, search_type, report_day, query_text)
);
CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_property_day ON gsc_query_daily(property, report_day);

CREATE TABLE IF NOT EXISTS gsc_page_daily (
  property        TEXT NOT NULL,
  search_type     TEXT NOT NULL DEFAULT 'web',
  report_day      TEXT NOT NULL,
  page_url        TEXT NOT NULL,
  clicks          INTEGER NOT NULL,
  impressions     INTEGER NOT NULL,
  ctr             REAL NOT NULL,
  position        REAL,
  collected_at_ms INTEGER NOT NULL,
  PRIMARY KEY (property, search_type, report_day, page_url)
);
CREATE INDEX IF NOT EXISTS idx_gsc_page_daily_property_day ON gsc_page_daily(property, report_day);

-- Device and country breakdowns share one table so both stay bounded and
-- comparable; `dimension` distinguishes them.
CREATE TABLE IF NOT EXISTS gsc_breakdown_daily (
  property        TEXT NOT NULL,
  search_type     TEXT NOT NULL DEFAULT 'web',
  report_day      TEXT NOT NULL,
  dimension       TEXT NOT NULL CHECK (dimension IN ('device', 'country')),
  value           TEXT NOT NULL,
  clicks          INTEGER NOT NULL,
  impressions     INTEGER NOT NULL,
  ctr             REAL NOT NULL,
  position        REAL,
  collected_at_ms INTEGER NOT NULL,
  PRIMARY KEY (property, search_type, report_day, dimension, value)
);
CREATE INDEX IF NOT EXISTS idx_gsc_breakdown_daily_property_day ON gsc_breakdown_daily(property, report_day);
