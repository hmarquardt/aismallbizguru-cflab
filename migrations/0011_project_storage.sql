-- Project identity and physical storage are separate concerns.
--
-- The primary `cflab` database keeps projects, users, memberships, sessions, and
-- this small registry. A project whose data lives in another D1 database records
-- the storage backend here; the Worker resolves the binding through an explicit
-- server-side allowlist (src/projects.ts), never from a request value.
--
-- Additive only: a new table plus INSERT OR IGNORE rows. Existing projects are
-- untouched and keep their default `primary` backend.

CREATE TABLE project_storage (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  backend TEXT NOT NULL CHECK (backend IN ('primary', 'analytics', 'bitcoin-signals')),
  binding TEXT NOT NULL CHECK (binding IN ('DB', 'ANALYTICS', 'BTC_SIGNALS')),
  migrations_dir TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  UNIQUE (binding)
);

INSERT OR IGNORE INTO apps (id, name, active, config_json, created_at, updated_at) VALUES
  ('bitcoin-signals', 'Bitcoin Signals', 1, '{"project":"bitcoin-signals","dashboard":"/bitcoin-signals","read_only_for_members":false}', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');

INSERT OR IGNORE INTO project_storage (app_id, backend, binding, migrations_dir, registered_at) VALUES
  ('bitcoin-signals', 'bitcoin-signals', 'BTC_SIGNALS', 'migrations-bitcoin-signals', '2026-10-25T00:00:00.000Z');
