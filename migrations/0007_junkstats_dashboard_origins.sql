-- Give the JunkStats dashboard its own operational app identity so its browser
-- origin is registered explicitly instead of relying on another app's origins.
INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at)
SELECT 'junkstats-dashboard', 'JunkStats Dashboard', 1, '{}', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = 'junkstats-dashboard');
INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('junkstats-dashboard', 'https://hmarquardt.github.io');
