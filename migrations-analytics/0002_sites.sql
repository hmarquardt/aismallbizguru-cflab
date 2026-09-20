-- Analytics Worker data model (cflab-analytics D1).
--
-- Additive migration: the legacy tables (sites, visitors, sessions, pageviews,
-- events) are left untouched so the existing dashboard and CFLab reporting
-- routes keep working while the Analytics Worker dual-writes legacy collection
-- during the transition. This migration:
--   1. creates the Site/Domain/Membership/EventName model;
--   2. maps legacy site IDs to analytics_sites.legacy_key and legacy
--      allowed_origins to analytics_domains;
--   3. backfills analytics_events from pageviews/events collected since the
--      CFLab cutover;
--   4. creates explicit daily aggregate tables for retention/rollups.

CREATE TABLE analytics_sites (
  id                 INTEGER PRIMARY KEY,
  public_id          TEXT NOT NULL UNIQUE,
  legacy_key         TEXT UNIQUE,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  active             INTEGER NOT NULL DEFAULT 1,
  respect_dnt        INTEGER NOT NULL DEFAULT 1,
  respect_gpc        INTEGER NOT NULL DEFAULT 1,
  raw_retention_days INTEGER NOT NULL DEFAULT 90,
  created_by_user_id TEXT NOT NULL,
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);

CREATE TABLE analytics_domains (
  id             INTEGER PRIMARY KEY,
  site_id        INTEGER NOT NULL,
  hostname       TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('primary', 'alias')),
  active         INTEGER NOT NULL DEFAULT 1,
  verified_at_ms INTEGER,
  created_at_ms  INTEGER NOT NULL,
  UNIQUE(site_id, hostname),
  FOREIGN KEY(site_id) REFERENCES analytics_sites(id)
);
CREATE INDEX idx_analytics_domains_hostname ON analytics_domains(hostname);

CREATE TABLE analytics_site_memberships (
  site_id       INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(site_id, user_id),
  FOREIGN KEY(site_id) REFERENCES analytics_sites(id)
);
CREATE INDEX idx_analytics_memberships_user ON analytics_site_memberships(user_id);

CREATE TABLE analytics_event_names (
  site_id       INTEGER NOT NULL,
  event_name    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(site_id, event_name)
);

CREATE TABLE analytics_events (
  id             INTEGER PRIMARY KEY,
  event_uid      TEXT NOT NULL,
  site_id        INTEGER NOT NULL,
  domain_id      INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  site_day       TEXT NOT NULL,
  event_kind     TEXT NOT NULL CHECK (event_kind IN ('pageview', 'event')),
  event_name     TEXT NOT NULL,
  session_id     TEXT,
  pathname       TEXT NOT NULL,
  referrer_host  TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  browser        TEXT,
  os             TEXT,
  device         TEXT,
  country_code   TEXT,
  region_code    TEXT,
  props_json     TEXT,
  UNIQUE(site_id, event_uid),
  FOREIGN KEY(site_id) REFERENCES analytics_sites(id),
  FOREIGN KEY(domain_id) REFERENCES analytics_domains(id)
);
CREATE INDEX idx_analytics_events_site_time ON analytics_events(site_id, received_at_ms);
CREATE INDEX idx_analytics_events_site_domain_time ON analytics_events(site_id, domain_id, received_at_ms);
CREATE INDEX idx_analytics_events_site_name_time ON analytics_events(site_id, event_name, received_at_ms);
CREATE INDEX idx_analytics_events_site_day ON analytics_events(site_id, site_day);

-- Daily rollups. Rebuilt by the scheduled maintenance handler from raw events
-- and deliberately retained after raw retention deletion, so long-range trends
-- survive while raw rows age out.
CREATE TABLE analytics_daily_site (
  site_id   INTEGER NOT NULL,
  site_day  TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events    INTEGER NOT NULL DEFAULT 0,
  sessions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(site_id, site_day)
);
CREATE TABLE analytics_daily_domains (
  site_id   INTEGER NOT NULL,
  site_day  TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events    INTEGER NOT NULL DEFAULT 0,
  sessions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(site_id, site_day, domain_id)
);
CREATE TABLE analytics_daily_pages (
  site_id   INTEGER NOT NULL,
  site_day  TEXT NOT NULL,
  pathname  TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events    INTEGER NOT NULL DEFAULT 0,
  sessions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(site_id, site_day, pathname)
);
CREATE TABLE analytics_daily_referrers (
  site_id       INTEGER NOT NULL,
  site_day      TEXT NOT NULL,
  referrer_host TEXT NOT NULL,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  sessions      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(site_id, site_day, referrer_host)
);
CREATE TABLE analytics_daily_events (
  site_id    INTEGER NOT NULL,
  site_day   TEXT NOT NULL,
  event_name TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  sessions   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(site_id, site_day, event_name)
);

-- Seed the two known legacy sites with stable opaque public tracking IDs.
-- The human-readable legacy keys stay as legacy_key so deployed snippets work.
INSERT OR IGNORE INTO analytics_sites
  (id, public_id, legacy_key, slug, name, timezone, active, respect_dnt, respect_gpc, raw_retention_days, created_by_user_id, created_at_ms, updated_at_ms)
VALUES
  (1, 'as_i5CfW5DyIwS3Zd0prGvRkF', 'junkdrawer', 'junkdrawer', 'Hank''s Junk Drawer', 'UTC', 1, 1, 1, 90, 'system:migration',
   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (2, 'as_Nrpoc6cKB5afip6oykD2Ab', 'top-hat-ferals', 'top-hat-ferals', 'Top Hat Ferals', 'UTC', 1, 1, 1, 90, 'system:migration',
   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Any other legacy site rows (unexpected, but safe) get a generated public ID.
INSERT OR IGNORE INTO analytics_sites
  (public_id, legacy_key, slug, name, timezone, active, respect_dnt, respect_gpc, raw_retention_days, created_by_user_id, created_at_ms, updated_at_ms)
SELECT 'as_' || substr(hex(randomblob(11)), 1, 22), old.id, old.id, old.name, 'UTC', old.is_active, 1, 1, 90, 'system:migration',
       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM sites old
WHERE old.id NOT IN ('junkdrawer', 'top-hat-ferals');

-- Map legacy allowed_origins JSON to domains: first origin is primary.
INSERT OR IGNORE INTO analytics_domains (site_id, hostname, kind, active, verified_at_ms, created_at_ms)
SELECT s.id,
       lower(rtrim(replace(replace(j.value, 'https://', ''), 'http://', ''), '/')),
       CASE WHEN CAST(j.key AS INTEGER) = 0 THEN 'primary' ELSE 'alias' END,
       s.active,
       NULL,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM sites old
JOIN analytics_sites s ON s.legacy_key = old.id
JOIN json_each(old.allowed_origins) j
WHERE old.allowed_origins IS NOT NULL AND trim(old.allowed_origins) <> ''
  AND trim(replace(replace(j.value, 'https://', ''), 'http://', '')) <> '';

-- Backfill raw pageviews collected since the CFLab cutover.
INSERT OR IGNORE INTO analytics_events
  (event_uid, site_id, domain_id, received_at_ms, site_day, event_kind, event_name, session_id, pathname,
   referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
   browser, os, device, country_code, region_code, props_json)
SELECT 'legacy:pv:' || pv.id, s.id, d.id,
       COALESCE(CAST(strftime('%s', pv.received_at) AS INTEGER), CAST(strftime('%s', pv.occurred_at) AS INTEGER), 0) * 1000,
       COALESCE(NULLIF(substr(pv.occurred_at, 1, 10), ''), '1970-01-01'),
       'pageview', 'pageview',
       NULLIF(pv.session_id, ''),
       COALESCE(NULLIF(pv.page_path, ''), '/'),
       NULLIF(lower(pv.referrer_domain), ''),
       NULLIF(pv.utm_source, ''), NULLIF(pv.utm_medium, ''), NULLIF(pv.utm_campaign, ''), NULLIF(pv.utm_content, ''), NULLIF(pv.utm_term, ''),
       NULLIF(pv.browser_name, ''), NULLIF(pv.os_name, ''), NULLIF(pv.device_type, ''),
       NULLIF(upper(pv.country), ''), NULLIF(upper(pv.region), ''),
       NULL
FROM pageviews pv
JOIN analytics_sites s ON s.legacy_key = pv.site_id
JOIN analytics_domains d ON d.id = COALESCE(
  (SELECT d2.id FROM analytics_domains d2 WHERE d2.site_id = s.id AND d2.hostname = lower(COALESCE(pv.page_host, '')) LIMIT 1),
  (SELECT d3.id FROM analytics_domains d3 WHERE d3.site_id = s.id AND d3.kind = 'primary' LIMIT 1)
);

-- Backfill custom events collected since the CFLab cutover.
INSERT OR IGNORE INTO analytics_events
  (event_uid, site_id, domain_id, received_at_ms, site_day, event_kind, event_name, session_id, pathname,
   referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
   browser, os, device, country_code, region_code, props_json)
SELECT 'legacy:ev:' || e.id, s.id, d.id,
       COALESCE(CAST(strftime('%s', e.received_at) AS INTEGER), CAST(strftime('%s', e.occurred_at) AS INTEGER), 0) * 1000,
       COALESCE(NULLIF(substr(e.occurred_at, 1, 10), ''), '1970-01-01'),
       'event',
       COALESCE(NULLIF(trim(e.event_name), ''), 'event'),
       NULLIF(e.session_id, ''),
       COALESCE(NULLIF(e.page_path, ''), '/'),
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       e.props_json
FROM events e
JOIN analytics_sites s ON s.legacy_key = e.site_id
-- The legacy events table has no page_host column, so historical events attach
-- to the site's primary domain.
JOIN analytics_domains d ON d.id =
  (SELECT d3.id FROM analytics_domains d3 WHERE d3.site_id = s.id AND d3.kind = 'primary' LIMIT 1);
