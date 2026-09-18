-- Human user authentication. Additive only: machine tokens (api_tokens) are unchanged.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  password_changed_at TEXT,
  last_login_at TEXT
);
CREATE TABLE project_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, app_id)
);
CREATE INDEX memberships_by_app ON project_memberships(app_id, user_id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX sessions_by_user ON sessions(user_id, id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX reset_tokens_by_user ON password_reset_tokens(user_id, id);
CREATE INDEX reset_tokens_by_expiry ON password_reset_tokens(expires_at);
