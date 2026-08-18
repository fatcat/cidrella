import { Router } from 'express';
import { passwordPolicyError } from './password-policy.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { getDb, audit } from '../db/init.js';
import * as User from '../models/user.js';

const router = Router();

// v0.4.15: `skipSuccessfulRequests: true` so a legitimate login after a few
// mistakes doesn't count against the lockout, closing the "1 bad IP DoSes
// the admin" vector the auth-security-tester flagged in v0.4.14. Burst raised
// from 10 → 20 for the same reason. Per-username counters were considered
// and rejected, they let an attacker lock the admin out by spraying bad
// passwords at the username, which is a worse foot-gun than the per-IP bound.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// New in v0.4.15: `/change-password` was unlimited in v0.4.14, letting a
// stolen-token holder brute-force the current password and pivot to a
// persistent takeover.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password change attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Dummy bcrypt hash used when the username is unknown so the response-time
// shape matches the valid-user path (defeats ~80ms-vs-~10ms user enumeration).
// Cost 10 matches the live password hash cost.
const DUMMY_HASH = bcrypt.hashSync(
  '__cidrella_dummy__' + Math.random().toString(36),
  10
);

function getJwtSecret() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  return row.value;
}

function generateToken(user) {
  const secret = getJwtSecret();
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password
    },
    secret,
    { expiresIn: '24h' }
  );
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const { username, password } = body;

    // Strict type check BEFORE any bcrypt or SQL call. Non-string values
    // crashed the Node process in v0.4.14 via the unhandled bcrypt type
    // error, this guard is the primary fix for the unauthenticated DoS.
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password must be strings' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length > 255 || password.length > 1024) {
      return res.status(400).json({ error: 'Username or password too long' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    // Always run bcrypt, even on unknown users, so response timing doesn't
    // leak whether the username exists.
    const hash = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      if (user) {
        audit(user.id, 'login_failed', 'user', user.id, { reason: 'invalid_password' });
      } else {
        // Audit unknown-user attempts so an operator watching the log can see
        // enumeration probes. Truncate the submitted username to avoid giant
        // entries from adversarial input.
        audit(null, 'login_failed', 'user', null, {
          reason: 'unknown_user',
          attempted_username: username.slice(0, 64)
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    audit(user.id, 'login', 'user', user.id, null);

    let preferences = {};
    try { preferences = JSON.parse(user.preferences || '{}'); } catch { /* ignore */ }

    const payload = {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        must_change_password: !!user.must_change_password,
        preferences
      }
    };
    if (user.password_reset_by) {
      payload.user.password_reset_by = user.password_reset_by;
    }
    res.json(payload);
  } catch (err) {
    console.error('Login error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', changePasswordLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const { current_password, new_password } = body;

    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      return res.status(400).json({ error: 'Current and new passwords must be strings' });
    }
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Same policy the first-run wizard enforces. These two used to disagree:
    // setup demanded uppercase + lowercase + digit and this route demanded only
    // a length, so the policy could be escaped by changing the password
    // immediately after install (duplicate-logic audit #39).
    {
      const pwErr = passwordPolicyError(new_password);
      if (pwErr) return res.status(400).json({ error: pwErr });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    const updatedUser = User.changePassword(db, user.id, hash);

    audit(user.id, 'password_changed', 'user', user.id, null);

    const token = generateToken(updatedUser);

    res.json({
      message: 'Password changed successfully',
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
        must_change_password: false
      }
    });
  } catch (err) {
    console.error('Change-password error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout: invalidate the caller's token by bumping
// users.updated_at PAST the token's iat. The auth middleware refuses
// tokens with `iat < updated_at`; because SQLite datetime() is 1-second
// granular, a login followed by an immediate logout in the same wall-
// clock second would leave `iat == updated_at` and the token would
// still verify. Bumping updated_at by 1 second closes the race.
// A proper blacklist would need persistent state; this approach is
// equivalent for a single-admin tool and doesn't grow unbounded.
router.post('/logout', (req, res) => {
  try {
    const db = getDb();
    User.bumpTokenVersion(db, req.user.id);
    audit(req.user.id, 'logout', 'user', req.user.id, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, role, must_change_password, preferences, password_reset_by, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  let preferences = {};
  try { preferences = JSON.parse(user.preferences || '{}'); } catch { /* ignore */ }

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    must_change_password: !!user.must_change_password,
    preferences,
    created_at: user.created_at
  };
  if (user.password_reset_by) {
    payload.password_reset_by = user.password_reset_by;
  }
  res.json(payload);
});

// PUT /api/auth/preferences: update current user's preferences
router.put('/preferences', (req, res) => {
  const ALLOWED_KEYS = ['time_format'];
  const VALID_TIME_FORMATS = ['locale', 'ampm', '24h'];

  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  for (const key of Object.keys(updates)) {
    if (!ALLOWED_KEYS.includes(key)) {
      return res.status(400).json({ error: `Unknown preference: ${key}` });
    }
  }

  if (updates.time_format && !VALID_TIME_FORMATS.includes(updates.time_format)) {
    return res.status(400).json({ error: `time_format must be one of: ${VALID_TIME_FORMATS.join(', ')}` });
  }

  const db = getDb();
  const user = db.prepare('SELECT preferences FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let prefs = {};
  try { prefs = JSON.parse(user.preferences || '{}'); } catch { /* ignore */ }

  Object.assign(prefs, updates);

  User.updatePreferences(db, req.user.id, prefs);

  res.json(prefs);
});

export default router;
