-- Register the real Top Hat Ferals production origins so browser auth and app
-- routes accept them. Idempotent and safe on fresh or existing environments.
INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at)
SELECT 'top-hat-ferals', 'Top Hat Ferals', 1, '{}', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = 'top-hat-ferals');
INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('top-hat-ferals', 'https://tophatferals.com');
INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('top-hat-ferals', 'https://www.tophatferals.com');
