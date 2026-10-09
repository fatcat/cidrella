-- Sign-in sessions.
--
-- A login JWT used to be the whole session: stateless, 24 hours, revoked only
-- by bumping users.updated_at past its iat, which killed every token the user
-- held. A row per sign-in gives the server what it needs to sign someone out
-- after inactivity, to end one browser's session without the others, and to
-- keep a record of who signed in from where and how each session ended.
--
-- The JWT carries the row's id as `sid`. models/session.js owns every rule.
--
-- last_activity_at moves only on sign-in and POST /api/auth/activity, which
-- the client sends when a person used the page. Polling requests never move
-- it, or an open dashboard would never go idle.
--
-- expires_at is 24 hours after sign-in, the same as the JWT's exp, and holds
-- whatever the inactivity setting is.
--
-- Ended rows stay as history and are pruned with the audit log. user_id goes
-- NULL when the user is deleted; username is a snapshot so the record still
-- says who it was.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN (
    'logout', 'idle', 'expired', 'password_changed', 'password_reset',
    'role_changed', 'user_deleted', 'revoked', 'restore'
  ))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);
