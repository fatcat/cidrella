import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/init.js';
import * as User from '../models/user.js';
import * as Setting from '../models/setting.js';

const router = Router();

// The setup endpoints are mounted PRE-AUTH so a brand-new install can reach
// them before any user exists. v0.4.15 tightens them: the handlers short-
// circuit the moment any user row exists in the DB or the
// installation_complete flag is set. That closes the v0.4.14 finding where
// an attacker could flip the flag and/or replace the seeded admin before
// the operator ever logged in. The status endpoint is still pre-auth so
// the client can decide whether to show the setup wizard.

function setupIsClosed(db) {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) return true;
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'installation_complete'").get();
  return flag?.value === 'true';
}

// GET /api/setup/status — tell the client whether the wizard should appear.
router.get('/status', (req, res) => {
  const db = getDb();
  res.json({ setup_required: !setupIsClosed(db) });
});

// POST /api/setup — complete first-run setup. Available ONLY when no user
// exists. `skip` is accepted in the same window but otherwise rejected.
router.post('/', async (req, res) => {
  try {
    const db = getDb();

    if (setupIsClosed(db)) {
      return res.status(409).json({ error: 'Setup is not available on this installation.' });
    }

    const body = req.body || {};
    const { username, password, skip } = body;

    if (skip === true) {
      Setting.upsertSetting(db, 'installation_complete', 'true');
      return res.json({ ok: true, skipped: true });
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password must be strings' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length < 3 || username.length > 64) {
      return res.status(400).json({ error: 'Username must be 3–64 characters' });
    }
    if (password.length < 8 || password.length > 1024) {
      return res.status(400).json({ error: 'Password must be 8–1024 characters' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a number' });
    }

    const hash = await bcrypt.hash(password, 10);

    db.transaction(() => {
      // Re-check inside the transaction so two concurrent POSTs can't both win.
      if (setupIsClosed(db)) {
        throw new Error('__setup_closed_during_txn__');
      }
      User.createUser(db, {
        username,
        passwordHash: hash,
        role: 'admin',
        mustChangePassword: false
      });
      Setting.upsertSetting(db, 'installation_complete', 'true');
    })();

    res.json({ ok: true, username });
  } catch (err) {
    if (err.message === '__setup_closed_during_txn__') {
      return res.status(409).json({ error: 'Setup is not available on this installation.' });
    }
    console.error('Setup error:', err?.message || err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

export default router;
