import { Router } from 'express';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSetting, audit } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { checkForUpdates } from '../utils/update-checker.js';
import { compareSemver } from '../utils/semver.js';
import { isDockerEnvironment } from '../utils/environment.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { DATA_DIR } from '../config/defaults.js';

const router = Router();
const STATUS_FILE = path.join(DATA_DIR, 'update-status.json');

// A status record is "stale" when it claims an update is in progress but no
// process is actually backing it. This happens when the update worker dies
// (or never starts) before its first progress write, the historical case
// being the v0.4.8/v0.4.9 sudo-under-NoNewPrivileges failure that left the
// API's initial `state: starting, pid: null` row sitting forever. We treat
// any in-progress record older than this threshold with no live pid as a
// failure that should be reaped, so the UI shows a Dismiss button instead
// of an indefinite spinner.
//
// Grace = 180s: the worker can take a meaningful amount of time to reach
// its first progress write on slow hosts. update.sh runs a DB snapshot,
// loads the shared bash lib, parses RELEASE.json, runs preflight, etc.
// before any progress callback fires. On a cold-Node + slow-disk LXC under
// IO contention, 90s was tight enough to risk false-reaping a healthy
// update. 180s is conservative; the only cost of being more conservative is
// a slightly longer "is it stuck?" window in the UI, which the explicit
// header reset affordance (planned v0.4.12) covers anyway.
const STALE_STATUS_GRACE_MS = 180 * 1000;

function rawReadStatusFile() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isStatusInProgress(state) {
  return state && state !== 'idle' && state !== 'completed' && state !== 'failed';
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Returns true if the record represents an update that *should* be running
// but isn't (no live worker, and enough time has passed that the worker
// would have written its first progress update by now if it were going to).
function isStaleInProgress(status) {
  if (!status || !isStatusInProgress(status.state)) return false;
  if (isPidAlive(status.pid)) return false;
  const updatedAt = Date.parse(status.updated_at || status.started_at || '');
  if (!Number.isFinite(updatedAt)) return true;
  return (Date.now() - updatedAt) > STALE_STATUS_GRACE_MS;
}

// Mutate a stale record into a `failed` one in-place on disk. We do not
// delete the file because the UI surfaces the error string from a `failed`
// state and gives the user a Dismiss button, both of which are better UX
// than the file simply disappearing (which would let the user start a new
// update without ever seeing what went wrong).
//
// The error message here is deliberately generic. An earlier version named
// the v0.4.8/v0.4.9 sudo-NoNewPrivileges trap explicitly, but that text
// survives unchanged into every future reaped record and misleads users
// hitting unrelated causes (a disk full, a polkit misconfig, a systemd
// failure the UI surfaces after the fact). Generic message + a pointer to
// the journal + the reason code is enough for an admin to diagnose; the
// historical context lives in RELEASE-NOTES.md where it belongs.
function reapStaleStatus(status) {
  const reaped = {
    ...status,
    state: 'failed',
    progress_pct: status.progress_pct || 0,
    message: 'Update worker did not report progress within the grace window',
    error: status.error || 'The update worker did not record any progress for 180 seconds after starting. It may have exited, crashed, or never launched. Check the server log and `journalctl -u cidrella-update@*.service` for spawn or execution errors. If the update actually did succeed, the version shown above the panel will already be current.',
    reason_code: 'worker_silent',
    updated_at: new Date().toISOString(),
    pid: null,
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(reaped), 'utf8');
  } catch {
    // If we can't write, return the in-memory reaped value anyway so the
    // current request sees a sane state. Next read will retry the write.
  }
  return reaped;
}

function readStatusFile() {
  const status = rawReadStatusFile();
  if (!status) return { state: 'idle' };
  if (isStaleInProgress(status)) return reapStaleStatus(status);
  return status;
}

// Exported for the server boot path so a service restart after a crashed
// update worker reaps the stuck record immediately, rather than waiting for
// the first GET /api/version/update-status to do it lazily.
export function reapStaleUpdateStatusOnBoot() {
  const status = rawReadStatusFile();
  if (status && isStaleInProgress(status)) {
    reapStaleStatus(status);
  }
}

function isUpdateRunning() {
  const status = readStatusFile();
  if (!isStatusInProgress(status.state)) return false;
  return isPidAlive(status.pid);
}

// Resolve a real pending update by cross-checking the stored value against
// the currently running code. Pure read, stale entries are cleared by
// clearStaleUpdateFlag() on boot and by checkForUpdates() on its next pass.
// The stored value can become stale when:
//  - the background check ran before an out-of-band upgrade (manual deploy)
//  - the running code was rolled back but the DB setting wasn't
//  - the user is on a newer version than what's published (development build)
function resolvePendingUpdate() {
  const stored = getSetting('update_available_version') || '';
  if (!stored) return null;
  if (compareSemver(stored, APP_VERSION) <= 0) return null;

  // Parse chain + manifest availability from stored settings. Both were
  // persisted by checkForUpdates() on its last successful run. Defensively
  // handle missing/corrupt values so a partial-write never crashes the
  // /api/version endpoint.
  let chain = [stored]; // default: direct one-hop
  try {
    const raw = getSetting('update_chain');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) chain = parsed;
    }
  } catch { /* fall through to direct one-hop */ }

  // Next-hop semantics: `version` is what the install handler will actually
  // install when the user clicks Install, i.e. chain[0], the first hop
  // the current version can reach. `chainTarget` is the eventual
  // destination (chain[chain.length - 1]). For a single-hop update these
  // are the same; for a multi-hop chain they differ, and the UI shows both
  // so the user understands "installing v0.5.0 now (step 1 of 2), en route
  // to v0.5.5 (latest)".
  //
  // After step 1 completes and the service restarts, the new running
  // version re-runs checkForUpdates() against a fresh manifest, which
  // produces a new chain starting at whatever is reachable from the new
  // current version. So "chain[0]" is always the right thing to install
  // right now, regardless of how deep we are in a multi-hop sequence.
  const nextHop = chain[0];
  const chainTarget = chain[chain.length - 1];

  let intermediateNotes = [];
  try {
    const raw = getSetting('update_intermediate_notes');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) intermediateNotes = parsed;
    }
  } catch { /* empty array fallback */ }

  return {
    version: nextHop,
    chainTarget,
    url: getSetting('update_release_url') || null,
    chain,
    manifestAvailable: getSetting('update_manifest_available') === 'true',
    intermediateNotes,
  };
}

// GET /api/version: current version and update status
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const pending = resolvePendingUpdate();
  res.json({
    version: APP_VERSION,
    // updateAvailable is the NEXT hop, the version that clicking Install
    // will actually install. For a direct jump this equals chainTarget;
    // for a multi-hop chain, it's the first reachable intermediate.
    updateAvailable: pending?.version || null,
    updateUrl: pending?.url || null,
    // Skip-upgrade fields (v0.4.12+). updateChain is always non-empty when
    // updateAvailable is non-null; a direct one-hop jump has length 1, a
    // multi-hop skip has length > 1. chainTarget is the final destination
    //, the highest version reachable by walking the chain.
    updateChain: pending?.chain || [],
    chainTarget: pending?.chainTarget || null,
    manifestAvailable: pending?.manifestAvailable ?? null,
    intermediateNotes: pending?.intermediateNotes || [],
    lastChecked: getSetting('update_checked_at') || null,
    updateCheckEnabled: getSetting('update_check_enabled') !== 'false',
    isDocker: isDockerEnvironment(),
  });
});

// POST /api/version/check: trigger immediate update check (admin only)
// Always bypasses the manifest cache so a user clicking Check Now sees the
// absolute latest state, not a 1-hour-old cached view.
router.post('/check', requireRole('admin'), async (req, res) => {
  try {
    const result = await checkForUpdates({ forceFresh: true });
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

// GET /api/version/update-status: read update progress (admin only)
router.get('/update-status', requireRole('admin'), (req, res) => {
  res.json(readStatusFile());
});

// POST /api/version/install: trigger update installation (admin only)
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

  // Start the update as its own systemd unit instance. The unit is a static
  // template (cidrella-update@.service) with no hardening, it runs as root
  // with default access, so update.sh can manipulate /opt and the data dir
  // freely. The cidrella service account is authorized to start instances
  // of this template via /etc/polkit-1/rules.d/49-cidrella.rules.
  //
  // This replaces the v0.4.8 path which called `sudo systemd-run …`. That
  // path broke silently when v0.4.8's hardening on cidrella.service began
  // implicitly setting NoNewPrivileges=yes, blocking sudo's setuid bit. The
  // failure was invisible because the spawn used stdio:'ignore'. We now use
  // execFileSync with --no-block (returns within ~50ms once systemd accepts
  // the start request) and capture stderr so any future failure surfaces in
  // the status file the UI reads, instead of leaving the panel stuck at
  // "Starting update...".
  // Instance name includes a wall-clock seconds suffix so a retry of the
  // same target version doesn't reuse a previous instance's state. Without
  // the suffix, a failed run of `cidrella-update@0.4.11.service` would
  // leave that exact unit instance in `failed` state until manually reset,
  // and the next start would refuse to launch. The suffix guarantees a
  // fresh instance per attempt. The polkit rule's prefix-match
  // (`cidrella-update@*.service`) accepts any suffix.
  const instanceTag = `${targetVersion}_${Math.floor(Date.now() / 1000)}`;
  const unitInstance = `cidrella-update@${instanceTag}.service`;
  try {
    execFileSync('systemctl', ['--no-block', 'start', unitInstance], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim() || err.message || 'unknown error';
    const failedStatus = {
      ...initialStatus,
      state: 'failed',
      progress_pct: 0,
      message: 'Failed to start update worker',
      error: `systemctl start ${unitInstance} failed: ${stderr}`,
      updated_at: new Date().toISOString(),
    };
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(failedStatus), 'utf8'); } catch {}
    return res.status(500).json({ error: failedStatus.error });
  }

  audit(req.user.id, 'update_started', 'system', null, {
    from_version: APP_VERSION,
    to_version: targetVersion,
  });

  res.status(202).json({ started: true, version: targetVersion });
});

// POST /api/version/update-dismiss: clear completed/failed status (admin only)
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
