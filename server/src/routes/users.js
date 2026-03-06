import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getDb, audit } from '../db/init.js';
import { ROLES, requireRole } from '../auth/roles.js';

const router = Router();

const requireAdmin = requireRole('admin');
const VALID_ROLES = Object.keys(ROLES);

// GET /api/users — list all users (no password hashes)
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(
    'SELECT id, username, role, must_change_password, created_at, updated_at FROM users ORDER BY created_at'
  ).all();
  res.json(users);
});

// POST /api/users — create user with random password
router.post('/', requireAdmin, async (req, res) => {
  const { username, role } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  try {
    const password = crypto.randomBytes(9).toString('base64');
    const hash = await bcrypt.hash(password, 10);

    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)'
    ).run(username.trim().toLowerCase(), hash, role);

    audit(req.user.id, 'user_created', 'user', result.lastInsertRowid, { username: username.trim(), role });

    const user = db.prepare(
      'SELECT id, username, role, must_change_password, created_at, updated_at FROM users WHERE id = ?'
    ).get(result.lastInsertRowid);

    res.status(201).json({ ...user, password });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// PUT /api/users/:id — update user role
router.put('/:id', requireAdmin, (req, res) => {
  const { role } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  db.prepare('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(role, user.id);
  audit(req.user.id, 'user_updated', 'user', user.id, { username: user.username, old_role: user.role, new_role: role });

  const updated = db.prepare(
    'SELECT id, username, role, must_change_password, created_at, updated_at FROM users WHERE id = ?'
  ).get(user.id);
  res.json(updated);
});

// DELETE /api/users/:id — delete user
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  audit(req.user.id, 'user_deleted', 'user', user.id, { username: user.username });
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password — admin resets password
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const password = crypto.randomBytes(9).toString('base64');
    const hash = await bcrypt.hash(password, 10);

    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(hash, user.id);

    audit(req.user.id, 'user_password_reset', 'user', user.id, { username: user.username });
    res.json({ password });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

export default router;
