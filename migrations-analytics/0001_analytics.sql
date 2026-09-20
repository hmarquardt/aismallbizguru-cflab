-- Dedicated CFLab analytics store (cflab-analytics D1), mirroring the legacy analytics
-- schema so historical exports can be imported unchanged. The collector deliberately does
-- not populate ip_hash, user_agent_hash, or raw_payload.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allowed_origins TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_path TEXT,
  last_path TEXT,
  user_agent_hash TEXT,
  ip_hash TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  landing_path TEXT,
  exit_path TEXT,
  referrer_url TEXT,
  referrer_domain TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  pageview_count INTEGER NOT NULL DEFAULT 0,
  heartbeat_count INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  bounced INTEGER
);
CREATE TABLE pageviews (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_url TEXT NOT NULL,
  page_host TEXT,
  page_path TEXT NOT NULL,
  page_query TEXT,
  page_title TEXT,
  referrer_url TEXT,
  referrer_domain TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  browser_name TEXT,
  browser_version TEXT,
  os_name TEXT,
  os_version TEXT,
  device_type TEXT,
  user_agent_hash TEXT,
  language TEXT,
  timezone TEXT,
  screen_width INTEGER,
  screen_height INTEGER,
  viewport_width INTEGER,
  viewport_height INTEGER,
  load_time_ms INTEGER,
  navigation_type TEXT,
  ip_hash TEXT,
  country TEXT,
  region TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  bot_reason TEXT,
  raw_payload TEXT
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_url TEXT,
  page_path TEXT,
  event_name TEXT,
  target_url TEXT,
  target_domain TEXT,
  value_number REAL,
  value_text TEXT,
  props_json TEXT
);
CREATE INDEX idx_pageviews_site_time ON pageviews(site_id, occurred_at);
CREATE INDEX idx_pageviews_site_path_time ON pageviews(site_id, page_path, occurred_at);
CREATE INDEX idx_pageviews_site_referrer_time ON pageviews(site_id, referrer_domain, occurred_at);
CREATE INDEX idx_pageviews_visitor_time ON pageviews(site_id, visitor_id, occurred_at);
CREATE INDEX idx_sessions_site_time ON sessions(site_id, started_at);
CREATE INDEX idx_sessions_visitor ON sessions(site_id, visitor_id);
INSERT OR IGNORE INTO sites (id, name, allowed_origins, is_active) VALUES ('junkdrawer', 'Hank''s Junk Drawer', '["https://hmarquardt.github.io"]', 1);
INSERT OR IGNORE INTO sites (id, name, allowed_origins, is_active) VALUES ('top-hat-ferals', 'Top Hat Ferals', '["https://tophatferals.com","https://www.tophatferals.com","https://hmarquardt.github.io"]', 1);
