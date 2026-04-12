import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getDb, getSetting, setSetting } from '../db/init.js';
import { DATA_DIR } from '../config/defaults.js';
import { APP_VERSION } from './version.js';
import { compareSemver } from './update-checker.js';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PRE_RESTORE_DIR = path.join(DATA_DIR, 'snapshots', 'pre-restore');
const MANIFEST_NAME = 'cidrella-backup-manifest.json';
const MANIFEST_TYPE = 'cidrella-backup';

/**
 * Create a backup archive of the CIDRella data
 */
export function createBackup(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Checkpoint WAL to ensure all data is in the main DB file
  db.pragma('wal_checkpoint(TRUNCATE)');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `cidrella-backup-${timestamp}.tar.gz`;
  const archivePath = path.join(BACKUP_DIR, filename);

  // Write a manifest so restore can verify compatibility.
  // Captures version, schema version, creation time, and included files.
  const schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  const manifest = {
    type: MANIFEST_TYPE,
    cidrella_version: APP_VERSION,
    schema_version: schemaVersion,
    created_at: new Date().toISOString(),
    includes: [],
  };

  // Build list of files/dirs to include (relative to DATA_DIR)
  const includes = [];
  if (fs.existsSync(path.join(DATA_DIR, 'cidrella.db'))) includes.push('cidrella.db');
  else if (fs.existsSync(path.join(DATA_DIR, 'ipam.db'))) includes.push('ipam.db');
  if (fs.existsSync(path.join(DATA_DIR, 'certs'))) includes.push('certs');
  if (fs.existsSync(path.join(DATA_DIR, 'dnsmasq'))) includes.push('dnsmasq');

  if (includes.length === 0) {
    throw new Error('No data files found to backup');
  }
  manifest.includes = includes.slice();

  // Stage manifest in DATA_DIR so tar picks it up as a sibling of cidrella.db.
  // Using a predictable name lets restore detect it without scanning.
  const manifestPath = path.join(DATA_DIR, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  try {
    execFileSync('tar', ['czf', archivePath, MANIFEST_NAME, ...includes], {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 60000
    });
  } finally {
    try { fs.unlinkSync(manifestPath); } catch { /* ignore */ }
  }

  const stat = fs.statSync(archivePath);
  const result = db.prepare(
    'INSERT INTO backups (filename, size_bytes) VALUES (?, ?)'
  ).run(filename, stat.size);

  // Enforce retention
  enforceRetention(db);

  return {
    id: result.lastInsertRowid,
    filename,
    size_bytes: stat.size,
    created_at: new Date().toISOString(),
    cidrella_version: APP_VERSION,
    schema_version: schemaVersion,
  };
}

/**
 * Read the manifest from a backup archive without extracting it.
 * Returns null if the archive has no manifest (legacy backups from before
 * manifests existed — we still allow restoring them but lose the safety checks).
 */
function readBackupManifest(archivePath) {
  try {
    const out = execFileSync('tar', ['xzf', archivePath, '-O', MANIFEST_NAME], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(out.toString('utf-8'));
    if (parsed?.type !== MANIFEST_TYPE) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Inspect a backup archive without modifying anything.
 * Returns { manifest, compatible, reason? }.
 */
export function inspectBackup(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error('Backup file not found');
  }

  const listing = execFileSync('tar', ['tzf', archivePath], { encoding: 'utf-8', timeout: 30000 });
  if (!listing.includes('cidrella.db') && !listing.includes('ipam.db')) {
    throw new Error('Invalid backup: missing database file');
  }

  // Validate that every entry resolves within DATA_DIR to prevent path traversal
  const resolvedDataDir = path.resolve(DATA_DIR);
  const entries = listing.split('\n').map(e => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const resolved = path.resolve(DATA_DIR, entry);
    if (!resolved.startsWith(resolvedDataDir + path.sep) && resolved !== resolvedDataDir) {
      throw new Error('Invalid archive: path traversal detected');
    }
  }

  const manifest = readBackupManifest(archivePath);

  // Compatibility rules:
  //   - No manifest → legacy backup, allow with a warning (caller decides)
  //   - Backup version > running code → refuse (running code can't support a newer schema)
  //   - Backup version <= running code → allow, migrations will run forward on startup
  if (!manifest) {
    return {
      manifest: null,
      compatible: true,
      warning: 'Legacy backup without manifest — version cannot be verified. Proceed with caution.',
    };
  }

  if (manifest.cidrella_version && compareSemver(manifest.cidrella_version, APP_VERSION) > 0) {
    return {
      manifest,
      compatible: false,
      reason: `Backup was created by CIDRella v${manifest.cidrella_version} which is newer than this instance (v${APP_VERSION}). Restoring would leave the database at a schema version this code cannot handle. Upgrade to at least v${manifest.cidrella_version} first, then restore.`,
    };
  }

  // Schema version sanity check (defensive — same idea as the version check)
  const db = getDb();
  const currentSchema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  if (manifest.schema_version != null && manifest.schema_version > currentSchema + 100) {
    // >100 is an absurd gap suggesting the backup is from an incompatible fork
    return {
      manifest,
      compatible: false,
      reason: `Backup schema version (${manifest.schema_version}) is wildly out of range vs current (${currentSchema}). Suspected incompatible or corrupt backup.`,
    };
  }

  return { manifest, compatible: true };
}

/**
 * Take a pre-restore snapshot to /var/lib/cidrella/snapshots/pre-restore/.
 * Unlike the pre-update snapshot, this is NOT managed by cidrella-rollback
 * — it's purely a safety net the admin can restore manually.
 */
function takePreRestoreSnapshot(db) {
  fs.mkdirSync(PRE_RESTORE_DIR, { recursive: true });

  // Checkpoint WAL so cidrella.db is fully current
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

  // Clear anything from a previous pre-restore and start fresh
  for (const f of fs.readdirSync(PRE_RESTORE_DIR)) {
    try { fs.rmSync(path.join(PRE_RESTORE_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const dbFile = path.join(DATA_DIR, 'cidrella.db');
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, path.join(PRE_RESTORE_DIR, 'cidrella.db'));
  for (const side of ['cidrella.db-wal', 'cidrella.db-shm']) {
    const src = path.join(DATA_DIR, side);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PRE_RESTORE_DIR, side));
  }
  const analytics = path.join(DATA_DIR, 'analytics.duckdb');
  if (fs.existsSync(analytics)) fs.copyFileSync(analytics, path.join(PRE_RESTORE_DIR, 'analytics.duckdb'));

  // Copy certs + dnsmasq (matching what's in a backup) so the pre-restore
  // state is a complete undo target.
  for (const sub of ['certs', 'dnsmasq']) {
    const src = path.join(DATA_DIR, sub);
    if (fs.existsSync(src)) {
      execFileSync('cp', ['-a', src, path.join(PRE_RESTORE_DIR, sub)]);
    }
  }

  const marker = {
    taken_at: new Date().toISOString(),
    cidrella_version: APP_VERSION,
  };
  fs.writeFileSync(path.join(PRE_RESTORE_DIR, 'manifest.json'), JSON.stringify(marker, null, 2));
}

/**
 * Restore from a backup archive.
 *
 * Flow:
 *  1. Inspect the archive (manifest, path traversal, version compatibility)
 *  2. Take a pre-restore snapshot to /var/lib/cidrella/snapshots/pre-restore/
 *  3. Extract into a staging dir, NOT directly over DATA_DIR — this way
 *     the running server never sees half-written files
 *  4. Atomically move the staged files into place
 *  5. Exit the process — systemd will restart with the new state
 *
 * The process exit (step 5) is what makes this safe. Without it, the
 * running server's open file descriptors would point at orphaned inodes
 * and any writes it made before restart would be silently lost.
 */
export function restoreBackup(archivePath, { allowIncompatible = false } = {}) {
  const inspection = inspectBackup(archivePath);
  if (!inspection.compatible && !allowIncompatible) {
    const err = new Error(inspection.reason || 'Backup is not compatible with this instance');
    err.code = 'BACKUP_INCOMPATIBLE';
    err.manifest = inspection.manifest;
    throw err;
  }

  const db = getDb();

  // 1. Pre-restore snapshot (safety net — not managed by cidrella-rollback)
  takePreRestoreSnapshot(db);

  // 2. Stage the extraction
  // 3. Stage extraction to /tmp — if anything goes wrong here, DATA_DIR is untouched
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-restore-'));
  try {
    execFileSync('tar', ['xzf', archivePath, '-C', stagingDir], {
      stdio: 'pipe',
      timeout: 60000,
    });

    // Legacy backups (pre-cidrella rename) contain ipam.db. Rename in-place
    // in staging so the file lands at DATA_DIR/cidrella.db. Otherwise the
    // restored data would be silently ignored because CIDRella opens
    // cidrella.db on startup, not ipam.db.
    const legacyIpam = path.join(stagingDir, 'ipam.db');
    if (fs.existsSync(legacyIpam) && !fs.existsSync(path.join(stagingDir, 'cidrella.db'))) {
      fs.renameSync(legacyIpam, path.join(stagingDir, 'cidrella.db'));
    }

    // 4. Swap staged files into DATA_DIR.
    //    The DB handle is kept open during this loop. better-sqlite3 still
    //    points at the original inode; Linux preserves it while the fd is
    //    held even though we unlink the path. Any in-flight SQLite writes
    //    during the loop are single-threaded with the handler, so they
    //    cannot race the file swap. The handle is closed below, immediately
    //    before we schedule the process exit.
    //
    //    If any copy step fails (ENOSPC, permission, etc.), DATA_DIR is
    //    left in a partially-restored state. We MUST still close the DB
    //    and exit so systemd restarts us — continuing to run with a
    //    half-swapped DATA_DIR is worse than a brief outage, and the
    //    pre-restore snapshot is the recovery path.
    const stagedItems = fs.readdirSync(stagingDir).filter(name => name !== MANIFEST_NAME);

    // If we just restored a cidrella.db from a legacy backup, remove any
    // pre-existing ipam.db on disk so there's no confusing leftover state.
    if (stagedItems.includes('cidrella.db')) {
      fs.rmSync(path.join(DATA_DIR, 'ipam.db'), { force: true });
      fs.rmSync(path.join(DATA_DIR, 'ipam.db-wal'), { force: true });
      fs.rmSync(path.join(DATA_DIR, 'ipam.db-shm'), { force: true });
    }

    for (const name of stagedItems) {
      const src = path.join(stagingDir, name);
      const dst = path.join(DATA_DIR, name);

      if (fs.existsSync(dst)) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
      // SQLite WAL/SHM must not be left over from the pre-restore state or
      // SQLite will get confused about inconsistent WAL vs DB on next open.
      if (name === 'cidrella.db') {
        fs.rmSync(path.join(DATA_DIR, 'cidrella.db-wal'), { force: true });
        fs.rmSync(path.join(DATA_DIR, 'cidrella.db-shm'), { force: true });
      }
      execFileSync('cp', ['-a', src, dst]);
    }
  } catch (copyErr) {
    // Something went wrong during staging or copy. DATA_DIR may be partially
    // swapped. Force an exit so systemd restarts us cleanly — continuing to
    // run with inconsistent state would be worse. The admin can recover from
    // /var/lib/cidrella/snapshots/pre-restore/.
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    setTimeout(() => {
      console.error('Restore failed mid-swap — exiting for restart', copyErr?.message);
      process.exit(1);
    }, 500);
    const wrapped = new Error(`Restore failed during file swap: ${copyErr.message}. Service will restart. Recover from /var/lib/cidrella/snapshots/pre-restore/ if needed.`);
    wrapped.cause = copyErr;
    throw wrapped;
  }

  // Happy path: clean up staging, close the DB handle, schedule exit.
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }

  // 5. Schedule process exit. systemd Restart=always will bring us back.
  //    We exit with code 0 after a short delay so the HTTP response can
  //    flush to the client before shutdown.
  setTimeout(() => {
    console.log('Restore complete — exiting for service restart');
    process.exit(0);
  }, 500);

  return {
    ok: true,
    message: 'Backup restored. Service is restarting...',
    manifest: inspection.manifest,
    warning: inspection.warning,
    pre_restore_snapshot: PRE_RESTORE_DIR,
  };
}

/**
 * List all backups, verifying files exist on disk
 */
export function listBackups(db) {
  const rows = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
  const result = [];

  for (const row of rows) {
    const filePath = path.join(BACKUP_DIR, row.filename);
    if (fs.existsSync(filePath)) {
      result.push(row);
    } else {
      // Clean up orphaned DB record
      db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    }
  }

  return result;
}

/**
 * Delete a backup file and its DB record
 */
export function deleteBackup(db, id) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Backup not found');

  const filePath = path.join(BACKUP_DIR, row.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  return row;
}

/**
 * Enforce backup retention limit
 */
function enforceRetention(db) {
  const maxCount = parseInt(getSetting('backup_retention_count') || '7', 10);

  const backups = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
  if (backups.length <= maxCount) return;

  const toDelete = backups.slice(maxCount);
  for (const backup of toDelete) {
    try {
      deleteBackup(db, backup.id);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get the backup directory path for a given backup
 */
export function getBackupPath(filename) {
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('Invalid backup filename');
  }
  return resolved;
}

/**
 * Start the backup scheduler
 */
export function startBackupScheduler() {
  const INTERVAL_MAP = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000
  };

  // Check every 15 minutes if a backup is due
  return setInterval(() => {
    try {
      const db = getDb();
      const scheduleValue = getSetting('backup_schedule');
      if (!scheduleValue || scheduleValue === 'off') return;

      const interval = INTERVAL_MAP[scheduleValue];
      if (!interval) return;

      const lastRunValue = getSetting('backup_last_run');
      const lastRunTime = lastRunValue ? new Date(lastRunValue).getTime() : 0;
      const now = Date.now();

      if (now - lastRunTime >= interval) {
        console.log(`Scheduled backup (${scheduleValue})...`);
        createBackup(db);

        // Update last run time
        setSetting('backup_last_run', new Date().toISOString());
        console.log('Scheduled backup completed');
      }
    } catch (err) {
      console.error('Scheduled backup failed:', err.message);
    }
  }, 15 * 60 * 1000);
}
