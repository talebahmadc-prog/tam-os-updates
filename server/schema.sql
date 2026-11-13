-- D1 schema for the TAM OS Store admin backend.

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  pass_hash    TEXT NOT NULL,          -- PBKDF2-SHA256 derived key (hex)
  pass_salt    TEXT NOT NULL,          -- 16-byte salt (hex)
  pass_iter    INTEGER NOT NULL,       -- iteration count used
  role         TEXT NOT NULL DEFAULT 'uploader',  -- 'admin' | 'uploader'
  active       INTEGER NOT NULL DEFAULT 1,
  failed_tries INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_login   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,         -- SHA-256(hex) of the cookie token
  user_id    INTEGER NOT NULL,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Audit trail: who uploaded/changed what.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,            -- username
  action     TEXT NOT NULL,           -- 'upload_apk' | 'edit_app' | 'edit_vehicle' | 'user_*' ...
  target     TEXT,                    -- app id / vehicle id / username
  detail     TEXT,                    -- free-form JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
