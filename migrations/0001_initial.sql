CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE app_origins (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  PRIMARY KEY (app_id, origin)
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX tokens_by_app ON api_tokens(app_id, id);
CREATE TABLE records (
  id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, resource, id)
);
CREATE INDEX records_by_status ON records(app_id, resource, status, id);
CREATE TABLE files (
  id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
);
CREATE TABLE proxy_sources (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, slug)
);
