import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb, audit } from '../db/init.js';
import { ROLES, requireRole } from '../auth/roles.js';
import { generateToken, expiryFromDays } from '../auth/tokens.js';
import * as User from '../models/user.js';

const router = Router();

const requireAdmin = requireRole('admin');
const VALID_ROLES = Object.keys(ROLES);
const USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

// GET /api/users/roles: authoritative role catalog for the UI
router.get('/roles', requireAdmin, (req, res) => {
  res.json(VALID_ROLES.map(value => ({
    value,
    label: ROLES[value].label,
    permissions: ROLES[value].permissions
  })));
});

// GET /api/users: list all users (no password hashes)
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(
    `SELECT u.id, u.username, u.role, u.kind, u.must_change_password, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM api_tokens t
              WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS active_tokens
       FROM users u ORDER BY u.created_at`
  ).all();
  res.json(users);
});

// POST /api/users: create user with random password
router.post('/', requireAdmin, async (req, res) => {
  const { username, role } = req.body;
  const kind = req.body.kind === 'service' ? 'service' : 'person';

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
    // A service account gets a password nobody ever learns: the hash is of
    // random bytes that are discarded here. Combined with the kind check in the
    // login route it cannot authenticate interactively at all. The column is
    // NOT NULL, which is why a value is written rather than left empty.
    const password = crypto.randomBytes(9).toString('base64');
    const hash = await bcrypt.hash(
      kind === 'service' ? crypto.randomBytes(32).toString('base64') : password,
      10
    );

    const user = User.createUser(db, {
      username: username.trim().toLowerCase(),
      passwordHash: hash,
      role,
      kind,
      // A machine has nobody to walk through a first-login password change, and
      // the flag would lock every route until one happened.
      mustChangePassword: kind !== 'service'
    });

    audit(req.user.id, 'user_created', 'user', user.id, { username: username.trim(), role, kind });

    if (kind === 'service') {
      res.status(201).json({ ...user, active_tokens: 0 });
      return;
    }
    res.status(201).json({ ...user, password });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// PUT /api/users/:id: update user role
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

// DELETE /api/users/:id: delete user
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

// POST /api/users/:id/reset-password: admin resets password
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

// ─── API tokens ──────────────────────────────────────────
//
// Tokens belong to service accounts only. Letting a person's account carry a
// long-lived credential would mean a human leaving the organisation takes a
// working key with them, and the account it belongs to still passes every
// permission check.

const TOKEN_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

function serviceAccountOr404(db, id, res) {
  const user = db.prepare('SELECT id, username, role, kind FROM users WHERE id = ?').get(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (user.kind !== 'service') {
    res.status(400).json({ error: 'Only service accounts can hold API tokens' });
    return null;
  }
  return user;
}

// GET /api/users/:id/tokens: metadata only, the secret is never recoverable
router.get('/:id/tokens', requireAdmin, (req, res) => {
  const db = getDb();
  const user = serviceAccountOr404(db, req.params.id, res);
  if (!user) return;

  const tokens = db.prepare(`
    SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
    FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC
  `).all(user.id);
  res.json(tokens);
});

// POST /api/users/:id/tokens: mint one, returned in the clear exactly once
router.post('/:id/tokens', requireAdmin, (req, res) => {
  const db = getDb();
  const user = serviceAccountOr404(db, req.params.id, res);
  if (!user) return;

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!TOKEN_NAME_RE.test(name)) {
    return res.status(400).json({
      error: 'Token name is required, up to 64 characters of letters, numbers, spaces, dots, hyphens or underscores'
    });
  }

  let expiresAt;
  try {
    expiresAt = expiryFromDays(req.body?.expires_in_days);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { token, hash, prefix } = generateToken();
  const result = db.prepare(`
    INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, name, hash, prefix, req.user.id, expiresAt);

  audit(req.user.id, 'api_token_created', 'user', user.id, {
    username: user.username, token_id: result.lastInsertRowid, name,
    expires_at: expiresAt || 'never'
  });

  const row = db.prepare(`
    SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
    FROM api_tokens WHERE id = ?
  `).get(result.lastInsertRowid);

  // The only time the secret leaves the server.
  res.status(201).json({ ...row, token });
});

// DELETE /api/users/:id/tokens/:tokenId: revoke, keeping the row as history
router.delete('/:id/tokens/:tokenId', requireAdmin, (req, res) => {
  const db = getDb();
  const user = serviceAccountOr404(db, req.params.id, res);
  if (!user) return;

  const token = db.prepare('SELECT id, name, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?')
    .get(req.params.tokenId, user.id);
  if (!token) {
    return res.status(404).json({ error: 'Token not found' });
  }
  if (token.revoked_at) {
    return res.status(409).json({ error: 'Token already revoked' });
  }

  db.prepare("UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?").run(token.id);
  audit(req.user.id, 'api_token_revoked', 'user', user.id, {
    username: user.username, token_id: token.id, name: token.name
  });
  res.json({ message: 'Token revoked' });
});

export default router;
