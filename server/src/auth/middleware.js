import jwt from 'jsonwebtoken';
import { getDb } from '../db/init.js';
import { looksLikeApiToken, resolveApiToken } from './tokens.js';
import * as Session from '../models/session.js';

// Paths that don't require authentication.
//
// `/api/logs/stream` is allowed through without a Bearer token NOT because
// it's truly public, but because EventSource (used by the live log viewer)
// cannot set custom HTTP headers. The route handler at server/src/routes/logs.js
// enforces ticket-or-jwt itself: a one-time, 30s, single-use stream ticket
// minted via POST /api/logs/stream-token (which still requires a valid JWT
// + dns:read permission). Skipping the global middleware here lets the
// route handler's ticket validation actually run, without this exemption
// the SSE GET is rejected at the middleware before the ticket is ever read.
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/login/totp',
  '/api/health',
  '/api/health/deep',
  '/api/logs/stream',
];

// Paths allowed when must_change_password is true. The first-run wizard's
// password step runs before the password has been changed and needs the
// setup state: the step markers, the password policy, and the switch that
// makes complexity optional. Those are markers and one setting, nothing the
// gate exists to protect, and the PUT still needs system:write.
const PASSWORD_CHANGE_PATHS = [
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/activity',
  '/api/auth/session',
  '/api/setup/state',
];

// Cached JWT secret, loaded on first use, cleared on key rotation
let _cachedJwtSecret = null;

function getJwtSecret(db) {
  if (!_cachedJwtSecret) {
    _cachedJwtSecret = db
      .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get()?.value;
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

  // A service account presents an API token rather than a login JWT. It is
  // checked before the JWT path and never falls through to it: a string that
  // carries the token prefix is a token, and if it does not resolve the answer
  // is 401, not "maybe it is a JWT".
  if (looksLikeApiToken(token)) {
    const { user, error } = resolveApiToken(db, token);
    if (error) {
      return res.status(401).json({ error });
    }
    req.user = user;
    return next();
  }

  const secret = getJwtSecret(db);

  if (!secret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Pin the algorithm to what we sign with (HS256). Without this, jwt.verify
    // accepts any algorithm in the token header, which is the classic
    // alg-confusion footing (e.g. an attacker flipping to 'none' or to an
    // asymmetric alg). Not exploitable with our symmetric secret, but this
    // closes the class outright rather than relying on the secret's shape.
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });

    // A two-factor challenge is signed with the same secret but carries a
    // purpose. It is a receipt for the password, never a session.
    if (decoded.purpose) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // The session row, not the token, decides whether the login still works:
    // signed out, idle, past 24 hours, or ended by an account change. A token
    // from before sessions existed has no sid and is refused the same way.
    const session = decoded.sid ? Session.getSession(db, decoded.sid) : null;
    const ended = Session.sessionEndReason(session);
    if (ended) {
      if (session && !session.ended_at) Session.endSession(db, session.id, ended);
      return res.status(401).json({
        error: 'Your session has ended. Please sign in again.',
        code: 'SESSION_ENDED',
        reason: session ? ended : null,
      });
    }

    const user = db
      .prepare('SELECT id, role, must_change_password FROM users WHERE id = ?')
      .get(decoded.id);
    if (!user || session.user_id !== user.id) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    req.user = {
      ...decoded,
      role: user.role,
      must_change_password: !!user.must_change_password,
      sessionId: session.id,
    };

    // If user must change password, only allow specific endpoints
    if (req.user.must_change_password && !PASSWORD_CHANGE_PATHS.includes(normalizedPath)) {
      return res.status(403).json({
        error: 'Password change required',
        code: 'MUST_CHANGE_PASSWORD',
      });
    }

    next();
  } catch (err) {
    // The token's exp is the session's 24 hour limit, so the library may
    // notice it first. The row stays unended until it is pruned; listings
    // already treat it as over.
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Your session has ended. Please sign in again.',
        code: 'SESSION_ENDED',
        reason: 'expired',
      });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
