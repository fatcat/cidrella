import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { getDb, audit } from '../db/init.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

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
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    audit(user.id, 'login_failed', 'user', user.id, { reason: 'invalid_password' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken(user);
  audit(user.id, 'login', 'user', user.id, null);

  let preferences = {};
  try { preferences = JSON.parse(user.preferences || '{}'); } catch { /* ignore */ }

  // If users.password_reset_by is non-null, the current password was set by
  // a CLI reset (via cidrella-reset-password). Surface the actor label in
  // the login response so the client can render a warning banner before the
  // mandatory password change. The column is cleared when the password is
  // successfully changed via /api/auth/change-password. If the DB is pre-v0.4.8
  // the column doesn't exist and the field is just absent — clients ignore it.
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
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
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
  // Clear password_reset_by at the same time so the warning banner from a
  // CLI reset disappears after the legit owner successfully changes it.
  // Migration 044 is unconditional in v0.4.8+, so the column always exists
  // on a running server — no need for runtime introspection.
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, password_reset_by = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(hash, user.id);

  audit(user.id, 'password_changed', 'user', user.id, null);

  // Issue new token without must_change_password flag
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
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
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const db = getDb();
  // password_reset_by is included so the auth store's fetchUser() path (hit
  // on page reload + token refresh) preserves the CLI-reset indicator across
  // navigation. Without this, reloading the page between login and the
  // Change Password screen would replace user.value with a payload that
  // doesn't carry password_reset_by, and the warning banner would disappear.
  // Migration 044 is unconditional in v0.4.8+ so we select it directly.
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

// PUT /api/auth/preferences — update current user's preferences
router.put('/preferences', (req, res) => {
  const ALLOWED_KEYS = ['time_format'];
  const VALID_TIME_FORMATS = ['locale', 'ampm', '24h'];

  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  // Validate keys
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

  db.prepare("UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(prefs), req.user.id);

  res.json(prefs);
});

export default router;
