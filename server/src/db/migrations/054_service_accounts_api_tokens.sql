-- Service accounts and their API tokens.
--
-- A machine cannot use the existing credential path: passwords are interactive,
-- must_change_password blocks every route until a human changes it, and a login
-- JWT lasts 24h. So a caller like the switch port map had no way in that did not
-- involve storing someone's password.
--
-- `kind` separates the two. A service account has no usable password and is
-- refused at /api/auth/login outright; it authenticates only by token. Keeping
-- it a column on users rather than a separate table means roles, requirePerm
-- and the audit log all keep working unchanged.
--
-- Tokens are stored as a SHA-256 hash, never in the clear, so a database leak
-- does not hand over working credentials. SHA-256 rather than bcrypt because
-- the secret is 256 bits of CSPRNG output, so there is nothing to brute force,
-- and bcrypt on every API request would be a denial-of-service lever.
--
-- expires_at NULL means the token never expires. That is deliberate: an
-- unattended poller has nobody to renew it, and a token that silently dies at
-- 3am is worse than one you revoke on purpose. revoked_at is the kill switch.

ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK(kind IN ('person','service'));

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
