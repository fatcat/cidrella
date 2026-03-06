import { Router } from 'express';
import bcrypt from 'bcrypt';
import { getDb } from '../db/init.js';

const router = Router();

// GET /api/setup/status — check if setup is needed
router.get('/status', (req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'installation_complete'").get();
  const complete = setting?.value === 'true';
  res.json({ setup_required: !complete });
});

// POST /api/setup — complete first-run setup
router.post('/', async (req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'installation_complete'").get();

  if (setting?.value === 'true') {
    return res.status(400).json({ error: 'Setup already completed' });
  }

  const { username, password, skip } = req.body;

  if (skip) {
    // Mark installation complete, keep auto-generated admin
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'installation_complete'").run();
    return res.json({ ok: true, skipped: true });
  }

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    db.transaction(() => {
      // Remove any existing users (fresh setup)
      db.prepare('DELETE FROM users').run();

      // Create the admin user
      db.prepare(
        'INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)'
      ).run(username, hash, 'admin');

      // Mark setup complete
      db.prepare("UPDATE settings SET value = 'true' WHERE key = 'installation_complete'").run();
    })();

    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: 'Setup failed: ' + err.message });
  }
});

export default router;
