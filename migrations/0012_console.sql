-- CFLab operations console: declarative service registry, saved queries, and an
-- append-only execution audit.
--
-- Every statement here is additive (CREATE TABLE/INDEX, INSERT OR IGNORE) so the
-- release gate can apply it without an operator approval. The registry is seeded
-- from configuration that actually exists in this repository and is verified live
-- by the release checks; nothing here invents a service or a deployed endpoint.
--
-- Credentials never belong in these tables. There is no column for a secret, and
-- the SQL workbench stores only a hash of executed statements.

CREATE TABLE IF NOT EXISTS console_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'project', 'admin-console')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  description TEXT NOT NULL,
  worker TEXT,
  base_url TEXT,
  dashboard_path TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS console_endpoints (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES console_services(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('public', 'session', 'administrator', 'machine-token', 'project-scope')),
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS console_endpoints_by_service ON console_endpoints(service_id);

CREATE TABLE IF NOT EXISTS console_resources (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES console_services(id),
  kind TEXT NOT NULL CHECK (kind IN ('database', 'bucket', 'worker', 'email', 'origin')),
  reference TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS console_resources_by_service ON console_resources(service_id);

CREATE TABLE IF NOT EXISTS console_repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- Schedule metadata only. Execution history is read from the subsystem that
-- already records it (`bs_collection_runs`, `job_runs`); this table never drives
-- a schedule and must not become a second scheduler.
CREATE TABLE IF NOT EXISTS console_jobs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES console_services(id),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  schedule_timezone TEXT NOT NULL,
  description TEXT NOT NULL,
  history_source TEXT NOT NULL CHECK (history_source IN ('signals-collection', 'analytics-maintenance', 'external-workflow')),
  history_key TEXT,
  stale_after_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS console_jobs_by_service ON console_jobs(service_id);

-- Per-administrator saved statements. Scoped by user_id in every query; the
-- database id is validated against the server-side allowlist at use time.
CREATE TABLE IF NOT EXISTS console_saved_queries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  database_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS console_saved_queries_by_user ON console_saved_queries(user_id, updated_at);

-- Append-only execution audit. It records the statement hash, never the statement
-- text or result data, so a log line cannot leak a literal from a query.
CREATE TABLE IF NOT EXISTS console_query_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  sql_hash TEXT NOT NULL,
  sql_length INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
  error_code TEXT,
  row_count INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS console_query_audit_by_created ON console_query_audit(created_at);

INSERT OR IGNORE INTO console_services (id, name, kind, status, description, worker, base_url, dashboard_path, updated_at) VALUES
  ('cflab-core', 'CFLab core API', 'worker', 'active', 'Shared identity, project records, files, proxy and public projections served by the primary Worker.', 'cflab', 'https://cflab.aismallbizguru.com', '/', '2026-10-26T00:00:00.000Z'),
  ('cflab-admin', 'CFLab administration', 'admin-console', 'active', 'Human-session administration: users, memberships, projects, app tokens, this console, and the Bitcoin Signals operator surfaces.', 'cflab', 'https://cflab.aismallbizguru.com', '/admin/users', '2026-10-26T00:00:00.000Z'),
  ('cflab-analytics', 'CFLab Analytics', 'worker', 'active', 'Privacy-first site analytics: collector, dashboard assets, per-site reports, and hourly rollup/purge maintenance.', 'cflab-analytics', 'https://analytics.aismallbizguru.com', '/', '2026-10-26T00:00:00.000Z'),
  ('bitcoin-signals', 'Bitcoin Signals', 'project', 'active', 'Private, single-operator bitcoin research instrument. Identity lives in the primary database; observations live in cflab-bitcoin-signals.', 'cflab', 'https://cflab.aismallbizguru.com', '/bitcoin-signals', '2026-10-26T00:00:00.000Z'),
  ('wildlife-field-recorder', 'Wildlife Field Recorder', 'project', 'active', 'Private field-observation project with an explicitly public Safari read projection (allowlisted fields and approved photos only).', 'cflab', 'https://cflab.aismallbizguru.com', NULL, '2026-10-26T00:00:00.000Z'),
  ('top-hat-ferals', 'Top Hat Ferals', 'project', 'active', 'Cat records project with a deliberately public read projection for its published site.', 'cflab', 'https://cflab.aismallbizguru.com', NULL, '2026-10-26T00:00:00.000Z'),
  ('junkstats-dashboard', 'JunkStats Dashboard', 'project', 'active', 'Project identity used by the JunkStats dashboard client for its analytics queries.', 'cflab', 'https://cflab.aismallbizguru.com', NULL, '2026-10-26T00:00:00.000Z'),
  ('analytics-dashboard', 'Analytics Dashboard', 'project', 'active', 'Project identity used by the Analytics dashboard client for its analytics queries.', 'cflab', 'https://cflab.aismallbizguru.com', NULL, '2026-10-26T00:00:00.000Z');

INSERT OR IGNORE INTO console_endpoints (id, service_id, method, path, access, summary) VALUES
  ('core-health', 'cflab-core', 'GET', '/api/health', 'public', 'Liveness only; no dependency checks and no CORS.'),
  ('core-version', 'cflab-core', 'GET', '/api/version', 'public', 'Non-sensitive deployment revision used by the release pipeline.'),
  ('core-login', 'cflab-core', 'POST', '/api/auth/login', 'public', 'Exchange email and password for a human session token.'),
  ('core-logout', 'cflab-core', 'POST', '/api/auth/logout', 'session', 'Revoke the current session.'),
  ('core-me', 'cflab-core', 'GET', '/api/auth/me', 'session', 'Caller identity and project memberships.'),
  ('core-change-password', 'cflab-core', 'POST', '/api/auth/change-password', 'session', 'Change password and revoke every session.'),
  ('core-forgot', 'cflab-core', 'POST', '/api/auth/forgot-password', 'public', 'Send a single-use recovery link if the account exists.'),
  ('core-reset', 'cflab-core', 'POST', '/api/auth/reset-password', 'public', 'Redeem a single-use recovery or invitation link.'),
  ('core-app', 'cflab-core', 'GET', '/api/apps/:app', 'machine-token', 'Project identity for a scoped machine token.'),
  ('core-records', 'cflab-core', 'GET', '/api/apps/:app/resources/:resource/records', 'project-scope', 'Paginated project records; requires records:read.'),
  ('core-records-write', 'cflab-core', 'POST', '/api/apps/:app/resources/:resource/records', 'project-scope', 'Create a project record; requires records:write.'),
  ('core-records-item', 'cflab-core', 'PATCH', '/api/apps/:app/resources/:resource/records/:id', 'project-scope', 'Update a project record; requires records:write.'),
  ('core-files', 'cflab-core', 'GET', '/api/apps/:app/files/:id/content', 'project-scope', 'Stream a stored file; requires files:read.'),
  ('core-files-write', 'cflab-core', 'POST', '/api/apps/:app/files', 'project-scope', 'Upload a stored file; requires files:write.'),
  ('core-proxy', 'cflab-core', 'POST', '/api/apps/:app/proxy/:source', 'project-scope', 'Allowlisted upstream proxy; requires proxy:use.'),
  ('core-collect', 'cflab-core', 'POST', '/api/analytics/collect', 'public', 'Collector route forwarded to the Analytics Worker; unknown sites are ignored.'),
  ('admin-home', 'cflab-admin', 'GET', '/', 'session', 'Operations console shell. Every figure is loaded from authenticated APIs.'),
  ('admin-login', 'cflab-admin', 'GET', '/admin/login', 'public', 'Sign-in page for the existing human auth system.'),
  ('admin-users-page', 'cflab-admin', 'GET', '/admin/users', 'administrator', 'User and membership administration screen.'),
  ('admin-account', 'cflab-admin', 'GET', '/account', 'session', 'Signed-in account screen.'),
  ('admin-users', 'cflab-admin', 'GET', '/api/admin/users', 'administrator', 'List users with memberships.'),
  ('admin-users-create', 'cflab-admin', 'POST', '/api/admin/users', 'administrator', 'Create a user and email an account-setup invitation.'),
  ('admin-users-update', 'cflab-admin', 'PATCH', '/api/admin/users/:id', 'administrator', 'Activate, deactivate, or change administrator status.'),
  ('admin-users-revoke', 'cflab-admin', 'POST', '/api/admin/users/:id/revoke-sessions', 'administrator', 'Revoke every session for one user.'),
  ('admin-memberships', 'cflab-admin', 'POST', '/api/admin/users/:id/memberships', 'administrator', 'Grant read or write project access.'),
  ('admin-projects', 'cflab-admin', 'GET', '/api/admin/projects', 'administrator', 'Project identity and storage backend side by side.'),
  ('admin-project-status', 'cflab-admin', 'GET', '/api/admin/projects/:app/status', 'administrator', 'Project health; research data remains owner-only for Bitcoin Signals.'),
  ('admin-apps', 'cflab-admin', 'GET', '/api/admin/apps', 'administrator', 'App registry listing.'),
  ('admin-apps-create', 'cflab-admin', 'POST', '/api/admin/apps', 'administrator', 'Register an app and its exact allowed origins.'),
  ('admin-app-tokens', 'cflab-admin', 'POST', '/api/admin/apps/:app/tokens', 'administrator', 'Mint a scoped machine token (shown once).'),
  ('console-overview', 'cflab-admin', 'GET', '/api/admin/console/overview', 'administrator', 'Operational summary, warnings, and recent activity.'),
  ('console-registry', 'cflab-admin', 'GET', '/api/admin/console/registry', 'administrator', 'Service, endpoint, resource, repository, and job registry.'),
  ('console-jobs', 'cflab-admin', 'GET', '/api/admin/console/jobs', 'administrator', 'Schedules with last attempt, last success, and staleness.'),
  ('console-system', 'cflab-admin', 'GET', '/api/admin/console/system', 'administrator', 'Revision, bindings, health, and backup attestation.'),
  ('console-databases', 'cflab-admin', 'GET', '/api/admin/console/databases', 'administrator', 'Allowlisted D1 inventories.'),
  ('console-schema', 'cflab-admin', 'GET', '/api/admin/console/databases/:id/schema', 'administrator', 'Tables, columns, and indexes for one allowlisted database.'),
  ('console-query', 'cflab-admin', 'POST', '/api/admin/console/databases/:id/query', 'administrator', 'Execute one read-only statement with bounded pagination.'),
  ('console-export', 'cflab-admin', 'POST', '/api/admin/console/databases/:id/export', 'administrator', 'Export a bounded read-only result set as CSV.'),
  ('console-saved', 'cflab-admin', 'GET', '/api/admin/console/saved-queries', 'administrator', 'Saved statements for the calling administrator.'),
  ('console-saved-create', 'cflab-admin', 'POST', '/api/admin/console/saved-queries', 'administrator', 'Save a statement for the calling administrator.'),
  ('console-saved-delete', 'cflab-admin', 'DELETE', '/api/admin/console/saved-queries/:id', 'administrator', 'Delete a saved statement owned by the caller.'),
  ('signals-page', 'bitcoin-signals', 'GET', '/bitcoin-signals', 'administrator', 'Signals radar shell; data is fetched with a session.'),
  ('signals-radar', 'bitcoin-signals', 'GET', '/api/bitcoin-signals/radar', 'administrator', 'Radar indicators, treasuries, hypotheses, alerts, and collection health.'),
  ('signals-arbitrage', 'bitcoin-signals', 'GET', '/api/bitcoin-signals/arbitrage', 'administrator', 'Funding, mark, index, and dated-basis calculations.'),
  ('signals-evidence', 'bitcoin-signals', 'GET', '/api/bitcoin-signals/evidence', 'administrator', 'Curated attributed evidence.'),
  ('signals-refresh', 'bitcoin-signals', 'POST', '/api/bitcoin-signals/refresh', 'administrator', 'Bounded manual collection (four runs per hour).'),
  ('signals-export', 'bitcoin-signals', 'GET', '/api/bitcoin-signals/export', 'administrator', 'Bounded CSV export of fixed datasets.'),
  ('analytics-collect', 'cflab-analytics', 'POST', '/collect', 'public', 'Canonical collector for registered Sites.'),
  ('analytics-collect-legacy', 'cflab-analytics', 'POST', '/api/analytics/collect', 'public', 'Legacy collector path kept for existing pages.'),
  ('analytics-sites', 'cflab-analytics', 'GET', '/api/sites', 'session', 'Sites visible to the caller Analytics identity.'),
  ('analytics-site', 'cflab-analytics', 'GET', '/api/sites/:site', 'session', 'Per-site report scoped by site role.'),
  ('analytics-site-domains', 'cflab-analytics', 'GET', '/api/sites/:site/domains', 'session', 'Site domains.'),
  ('analytics-site-members', 'cflab-analytics', 'GET', '/api/sites/:site/members', 'session', 'Site memberships.'),
  ('analytics-site-snippet', 'cflab-analytics', 'GET', '/api/sites/:site/snippet', 'session', 'Install snippet for the site.'),
  ('analytics-dashboard', 'cflab-analytics', 'GET', '/', 'session', 'Analytics dashboard assets (the page authenticates its own queries).'),
  ('wildlife-records', 'wildlife-field-recorder', 'GET', '/api/apps/wildlife-field-recorder/resources/:resource/records', 'machine-token', 'Private project records for a scoped token.'),
  ('wildlife-safari', 'wildlife-field-recorder', 'GET', '/api/public/wildlife-safari/observations', 'public', 'Approved public observations with allowlisted fields only.'),
  ('wildlife-safari-file', 'wildlife-field-recorder', 'GET', '/api/public/wildlife-safari/files/:id', 'public', 'Image bytes for an approved public observation.'),
  ('tophat-records', 'top-hat-ferals', 'GET', '/api/apps/top-hat-ferals/resources/:resource/records', 'machine-token', 'Private project records for a scoped token.'),
  ('tophat-public', 'top-hat-ferals', 'GET', '/api/public/top-hat-ferals/:resource', 'public', 'Deliberately public records projection.'),
  ('tophat-file', 'top-hat-ferals', 'GET', '/api/public/top-hat-ferals/files/:id', 'public', 'Public photo bytes.'),
  ('junkstats-identity', 'junkstats-dashboard', 'GET', '/api/apps/junkstats-dashboard', 'machine-token', 'Project identity check for the dashboard client.'),
  ('analytics-dashboard-identity', 'analytics-dashboard', 'GET', '/api/apps/analytics-dashboard', 'machine-token', 'Project identity check for the dashboard client.');

INSERT OR IGNORE INTO console_resources (id, service_id, kind, reference, detail) VALUES
  ('db-primary', 'cflab-core', 'database', 'DB', 'cflab (primary): identity, sessions, memberships, apps, records, files, and this console registry.'),
  ('db-analytics', 'cflab-analytics', 'database', 'ANALYTICS', 'cflab-analytics: sites, events, and daily rollups.'),
  ('db-signals', 'bitcoin-signals', 'database', 'BTC_SIGNALS', 'cflab-bitcoin-signals: observations, evidence, alerts, and collection history.'),
  ('r2-files', 'cflab-core', 'bucket', 'FILES', 'cflab-files: project file objects under apps/<app>/files/<id>.'),
  ('worker-primary', 'cflab-core', 'worker', 'cflab', 'Primary Worker: API, console, admin pages, and both Bitcoin Signals crons.'),
  ('worker-analytics', 'cflab-analytics', 'worker', 'cflab-analytics', 'Analytics Worker: dashboard assets, collector, sites API, and hourly maintenance.'),
  ('email-primary', 'cflab-core', 'email', 'EMAIL', 'Cloudflare Email Sending binding used for invitations and optional Signals alerts.'),
  ('origin-primary', 'cflab-core', 'origin', 'https://cflab.aismallbizguru.com', 'Primary custom domain; also serves lab.aismallbizguru.com/* routing.'),
  ('origin-analytics', 'cflab-analytics', 'origin', 'https://analytics.aismallbizguru.com', 'Analytics custom domain; also mounted on both collect paths.');

INSERT OR IGNORE INTO console_repositories (id, name, url, branch, detail) VALUES
  ('cflab', 'aismallbizguru-cflab', 'git@github.com:hmarquardt/aismallbizguru-cflab.git', 'main', 'Authoritative source for both Workers, migrations, tests, and the release pipeline.');

INSERT OR IGNORE INTO console_jobs (id, service_id, name, schedule, schedule_timezone, description, history_source, history_key, stale_after_minutes, active) VALUES
  ('signals-hourly', 'bitcoin-signals', 'Bitcoin Signals hourly market collection', '7 * * * *', 'UTC', 'OKX, Kraken, Coinbase, and mempool.space collection with normalized funding and basis history.', 'signals-collection', 'hourly', 150, 1),
  ('signals-daily', 'bitcoin-signals', 'Bitcoin Signals daily treasury collection', '41 6 * * *', 'UTC', 'Authenticated CoinGecko public-company treasury collection and alert evaluation.', 'signals-collection', 'daily', 1800, 1),
  ('analytics-maintenance', 'cflab-analytics', 'Analytics rollup and retention', '17 * * * *', 'UTC', 'Rebuild recent daily rollups and purge raw events past each Site retention window.', 'analytics-maintenance', NULL, 180, 1),
  ('backup-workflow', 'cflab-core', 'Three-database backup workflow', '37 3 * * *', 'UTC', 'GitHub Actions backup: dump, restore-verify, and append-only upload. History is recorded by the workflow, not this Worker.', 'external-workflow', NULL, 1800, 1);




