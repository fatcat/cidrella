import { Router } from 'express';
import { getSetting } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { checkForUpdates } from '../utils/update-checker.js';

const router = Router();

// GET /api/version — current version and update status
router.get('/', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  res.json({
    version: APP_VERSION,
    updateAvailable: getSetting('update_available_version') || null,
    updateUrl: getSetting('update_release_url') || null,
    lastChecked: getSetting('update_checked_at') || null,
    updateCheckEnabled: getSetting('update_check_enabled') !== 'false',
  });
});

// POST /api/version/check — trigger immediate update check (admin only)
router.post('/check', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await checkForUpdates();
    res.json({
      version: APP_VERSION,
      updateAvailable: result?.version || null,
      updateUrl: result?.url || null,
      lastChecked: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Update check failed' });
  }
});

export default router;
