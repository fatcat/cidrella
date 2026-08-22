// API tokens for service accounts.
//
// The token is shown once at creation and only its SHA-256 hash is kept. See
// migration 054 for why SHA-256 rather than bcrypt.

import crypto from 'crypto';

// Recognisable on sight, so a leaked string can be identified as a CIDRella
// credential in a log or a paste without having to try it.
export const TOKEN_PREFIX = 'cidr_pat_';
const SECRET_BYTES = 32;
const PREFIX_DISPLAY_LEN = TOKEN_PREFIX.length + 8;

// last_used_at is a convenience, not an audit record, so it is written at most
// once a minute per token rather than on every request.
const LAST_USED_THROTTLE_MS = 60_000;

export function looksLikeApiToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken() {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token = TOKEN_PREFIX + secret;
  return { token, hash: hashToken(token), prefix: token.slice(0, PREFIX_DISPLAY_LEN) };
}

/**
 * Turn `expires_in_days` from the API into a stored timestamp.
 * Zero, null and undefined all mean "never", which is stored as NULL.
 */
export function expiryFromDays(days) {
  if (days === undefined || days === null || days === '' || Number(days) === 0) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('expires_in_days must be a whole number of days, or 0 for never');
  }
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function isExpired(row, now) {
  if (!row.expires_at) return false;
  return new Date(row.expires_at + 'Z').getTime() <= now;
}

/**
 * Resolve a presented token to its principal.
 *
 * The user row is joined on every call rather than trusted from the token, so a
 * role change or a deletion takes effect on the next request. That is stronger
 * than the JWT path, which can only invalidate by comparing issue time against
 * users.updated_at.
 *
 * Returns { user } on success, or { error } with a reason safe to return.
 */
export function resolveApiToken(db, token) {
  const row = db.prepare(`
    SELECT t.id, t.user_id, t.expires_at, t.revoked_at, t.last_used_at,
           u.username, u.role, u.kind
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hashToken(token));

  if (!row) return { error: 'Invalid token' };
  if (row.revoked_at) return { error: 'Token revoked' };

  const now = Date.now();
  if (isExpired(row, now)) return { error: 'Token expired' };

  if (!row.last_used_at || now - new Date(row.last_used_at + 'Z').getTime() > LAST_USED_THROTTLE_MS) {
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  }

  return {
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      kind: row.kind,
      token_id: row.id,
      // A service account has no password, so this gate never applies to it.
      must_change_password: false
    }
  };
}
