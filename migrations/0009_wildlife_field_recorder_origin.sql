-- Register the Wildlife Field Recorder browser deployment origin so CFLab
-- authorizes requests that originate from the hosted Junkdrawer page.
--
-- Why this migration exists: the Wildlife Field Recorder page is served from
-- https://hmarquardt.github.io, a different origin from cflab.aismallbizguru.com.
-- CFLab's /api/auth/* CORS middleware only accepts same-origin requests or
-- origins registered in app_origins for an active application, and the
-- /api/apps/:app/* middleware checks app_origins for that specific application.
-- The row for this app previously existed only as a side effect of the live
-- LabBox baseline import (.migration/snapshots), so a fresh CFLab database did
-- not reproduce it. This migration makes the registration reproducible and
-- idempotent: it is a no-op wherever the row already exists.
--
-- Browser CORS hygiene only. Registering an origin grants no data access: every
-- app route still requires a human session or app token plus project access.
-- This intentionally does NOT introduce a wildcard or any other origin.
INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at)
SELECT 'wildlife-field-recorder', 'Wildlife Field Recorder', 1, '{}', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = 'wildlife-field-recorder');
INSERT OR IGNORE INTO app_origins (app_id, origin) VALUES ('wildlife-field-recorder', 'https://hmarquardt.github.io');
