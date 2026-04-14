import jwt from 'jsonwebtoken';
import { getDb } from '../db/init.js';

// Paths that don't require authentication.
//
// `/api/logs/stream` is allowed through without a Bearer token NOT because
// it's truly public, but because EventSource (used by the live log viewer)
// cannot set custom HTTP headers. The route handler at server/src/routes/logs.js
// enforces ticket-or-jwt itself: a one-time, 30s, single-use stream ticket
// minted via POST /api/logs/stream-token (which still requires a valid JWT
// + dns:read permission). Skipping the global middleware here lets the
// route handler's ticket validation actually run — without this exemption
// the SSE GET is rejected at the middleware before the ticket is ever read.
const PUBLIC_PATHS = ['/api/auth/login', '/api/health', '/api/health/deep', '/api/logs/stream'];

// Paths allowed when must_change_password is true
const PASSWORD_CHANGE_PATHS = ['/api/auth/change-password', '/api/auth/me'];

// Cached JWT secret — loaded on first use, cleared on key rotation
let _cachedJwtSecret = null;

function getJwtSecret(db) {
  if (!_cachedJwtSecret) {
    _cachedJwtSecret = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get()?.value;
  }
  return _cachedJwtSecret;
}

/** Call this after rotating the JWT secret so the cache is refreshed on next request. */
export function clearJwtSecretCache() {
  _cachedJwtSecret = null;
}

export function authMiddleware(req, res, next) {
  // Skip auth for non-API routes (static files)
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Skip auth for public paths
  const normalizedPath = req.path.replace(/\/+$/, '') || '/';
  if (PUBLIC_PATHS.includes(normalizedPath)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);
  const db = getDb();
  const secret = getJwtSecret(db);

  if (!secret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const decoded = jwt.verify(token, secret);

    // Re-validate user from DB to catch deletions/role changes
    const user = db.prepare('SELECT id, role, must_change_password, updated_at FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    // Check if token was issued before last user update (password change, role change, etc.)
    if (user.updated_at) {
      const updatedAt = Math.floor(new Date(user.updated_at + 'Z').getTime() / 1000);
      if (decoded.iat < updatedAt) {
        return res.status(401).json({ error: 'Token invalidated. Please log in again.' });
      }
    }

    req.user = { ...decoded, role: user.role, must_change_password: !!user.must_change_password };

    // If user must change password, only allow specific endpoints
    if (req.user.must_change_password && !PASSWORD_CHANGE_PATHS.includes(normalizedPath)) {
      return res.status(403).json({
        error: 'Password change required',
        code: 'MUST_CHANGE_PASSWORD'
      });
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
