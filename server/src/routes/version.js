import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSetting, audit } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { checkForUpdates, compareSemver } from '../utils/update-checker.js';
import { isDockerEnvironment } from '../utils/environment.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { DATA_DIR } from '../config/defaults.js';

const router = Router();
const STATUS_FILE = path.join(DATA_DIR, 'update-status.json');
const INSTALL_DIR = '/opt/cidrella';

function readStatusFile() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { state: 'idle' };
  }
}

function isUpdateRunning() {
  const status = readStatusFile();
  if (!status.pid || status.state === 'completed' || status.state === 'failed' || status.state === 'idle') {
    return false;
  }
  // Check if the PID is still alive
  try {
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Resolve a real pending update by cross-checking the stored value against
// the currently running code. Pure read — stale entries are cleared by
// clearStaleUpdateFlag() on boot and by checkForUpdates() on its next pass.
// The stored value can become stale when:
//  - the background check ran before an out-of-band upgrade (manual deploy)
//  - the running code was rolled back but the DB setting wasn't
//  - the user is on a newer version than what's published (development build)
function resolvePendingUpdate() {
  const stored = getSetting('update_available_version') || '';
  if (!stored) return null;
  if (compareSemver(stored, APP_VERSION) <= 0) return null;
  return {
    version: stored,
    url: getSetting('update_release_url') || null,
  };
}

// GET /api/version — current version and update status
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const pending = resolvePendingUpdate();
  res.json({
    version: APP_VERSION,
    updateAvailable: pending?.version || null,
    updateUrl: pending?.url || null,
    lastChecked: getSetting('update_checked_at') || null,
    updateCheckEnabled: getSetting('update_check_enabled') !== 'false',
    isDocker: isDockerEnvironment(),
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

// GET /api/version/update-status — read update progress (admin only)
router.get('/update-status', requireRole('admin'), (req, res) => {
  res.json(readStatusFile());
});

// POST /api/version/install — trigger update installation (admin only)
router.post('/install', requireRole('admin'), (req, res) => {
  if (isDockerEnvironment()) {
    return res.status(400).json({ error: 'Auto-update is not available in Docker deployments. Pull the latest image to update.' });
  }

  const pending = resolvePendingUpdate();
  if (!pending) {
    return res.status(400).json({ error: 'No update available.' });
  }
  const targetVersion = pending.version;

  if (isUpdateRunning()) {
    return res.status(409).json({ error: 'An update is already in progress.' });
  }

  // Write initial status file
  const initialStatus = {
    state: 'starting',
    from_version: APP_VERSION,
    to_version: targetVersion,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress_pct: 0,
    message: 'Starting update...',
    error: null,
    backup_path: null,
    pid: null,
  };

  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(initialStatus), 'utf8');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to initialize update status file.' });
  }

  // Spawn update as a transient systemd service (NOT a scope). A scope inherits
  // the invoker's mount namespace, so it would carry cidrella.service's
  // ProtectSystem=strict + ReadWritePaths=/var/lib/cidrella restrictions into
  // the child — making /opt read-only and breaking `rm -rf /opt/cidrella-b` in
  // update.sh. A transient service unit gets a fresh namespace with no
  // inherited hardening, and still survives cidrella.service restart because
  // it's a separate unit with its own lifecycle.
  const child = spawn('sudo', [
    'systemd-run', '--unit=cidrella-update', '--collect',
    `${INSTALL_DIR}/update.sh`,
    '--version', targetVersion,
    '--progress-file', STATUS_FILE,
    '--from-api',
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  audit(req.user.id, 'update_started', 'system', null, {
    from_version: APP_VERSION,
    to_version: targetVersion,
  });

  res.status(202).json({ started: true, version: targetVersion });
});

// POST /api/version/update-dismiss — clear completed/failed status (admin only)
router.post('/update-dismiss', requireRole('admin'), (req, res) => {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      fs.unlinkSync(STATUS_FILE);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear update status.' });
  }
});

export default router;
