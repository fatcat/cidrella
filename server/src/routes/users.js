import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb, audit } from '../db/init.js';
import { ROLES, requireRole } from '../auth/roles.js';
import * as User from '../models/user.js';

const router = Router();

const requireAdmin = requireRole('admin');
const VALID_ROLES = Object.keys(ROLES);
const USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

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
  if (username.trim().length > 64) {
    return res.status(400).json({ error: 'Username must be 64 characters or fewer' });
  }
  if (!USERNAME_RE.test(username.trim())) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, dots, hyphens, and underscores' });
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

    const user = User.createUser(db, {
      username: username.trim().toLowerCase(),
      passwordHash: hash,
      role,
      mustChangePassword: true
    });

    audit(req.user.id, 'user_created', 'user', user.id, { username: username.trim(), role });

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

  const updated = User.updateRole(db, user.id, role);
  audit(req.user.id, 'user_updated', 'user', user.id, { username: user.username, old_role: user.role, new_role: role });

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

  try {
    User.deleteUser(db, user.id);
    audit(req.user.id, 'user_deleted', 'user', user.id, { username: user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/users/:id/reset-password — admin resets password
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const password = crypto.randomBytes(9).toString('base64');
    const hash = await bcrypt.hash(password, 10);

    User.resetPassword(db, user.id, hash);

    audit(req.user.id, 'user_password_reset', 'user', user.id, { username: user.username });
    res.json({ password });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

export default router;
