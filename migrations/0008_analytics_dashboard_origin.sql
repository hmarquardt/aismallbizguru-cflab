-- Register the Analytics Worker dashboard origin so the browser at
-- https://analytics.aismallbizguru.com can call CFLab /api/auth/* for sign-in.
-- This is browser CORS hygiene only; it grants no data access by itself.
INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at)
SELECT 'analytics-dashboard', 'Analytics Dashboard', 1, '{}', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = 'analytics-dashboard');
INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('analytics-dashboard', 'https://analytics.aismallbizguru.com');
