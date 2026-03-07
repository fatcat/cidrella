import jwt from 'jsonwebtoken';
import { getDb } from '../db/init.js';

// Paths that don't require authentication
const PUBLIC_PATHS = ['/api/auth/login', '/api/health'];

// Paths allowed when must_change_password is true
const PASSWORD_CHANGE_PATHS = ['/api/auth/change-password', '/api/auth/me'];

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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);
  const db = getDb();
  const settings = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();

  if (!settings) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const decoded = jwt.verify(token, settings.value);

    // Re-validate user from DB to catch deletions/role changes
    const user = db.prepare('SELECT id, role, must_change_password FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
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
