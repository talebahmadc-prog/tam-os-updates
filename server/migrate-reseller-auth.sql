-- Migrate sessions to the self-contained shape (username + role) so sessions
-- work for both local store accounts and delegated distributor logins.
-- Safe to run: sessions are ephemeral (everyone simply logs in again).
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  role       TEXT NOT NULL,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);
