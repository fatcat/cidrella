import { Router } from 'express';
import { getSetting } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { checkForUpdates } from '../utils/update-checker.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';

const router = Router();

// GET /api/version — current version and update status
router.get('/', requirePerm('subnets:read'), (req, res) => {
  res.json({
    version: APP_VERSION,
    updateAvailable: getSetting('update_available_version') || null,
    updateUrl: getSetting('update_release_url') || null,
    lastChecked: getSetting('update_checked_at') || null,
    updateCheckEnabled: getSetting('update_check_enabled') !== 'false',
  });
});

// POST /api/version/check — trigger immediate update check (admin only)
router.post('/check', requireRole('admin'), async (req, res) => {
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
