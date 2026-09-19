-- Optional two-factor sign-in with a time-based one-time password (TOTP,
-- RFC 6238) plus one-time backup codes.
--
-- totp_secret holds the base32 secret from the moment setup starts; it only
-- counts once totp_enabled is 1, which happens after the user has proven the
-- authenticator works by entering a code. totp_last_step remembers the last
-- 30-second step a code was accepted for, so a code cannot be replayed inside
-- the acceptance window.
--
-- Backup codes are stored as SHA-256 hashes, never in the clear, the same
-- reasoning as api_tokens: the code is CSPRNG output with nothing to brute
-- force, so a bcrypt cost per login attempt would only be a denial-of-service
-- lever. used_at marks a code spent; spent rows are kept so the audit trail
-- can say which one was used.

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

CREATE TABLE IF NOT EXISTS user_backup_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_backup_codes_user ON user_backup_codes(user_id);
