import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb, audit } from '../db/init.js';

const router = Router();

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
router.post('/login', async (req, res) => {
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

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password
    }
  });
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  if (new_password.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
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
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?"
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
  const user = db.prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?').get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    must_change_password: !!user.must_change_password,
    created_at: user.created_at
  });
});

export default router;
