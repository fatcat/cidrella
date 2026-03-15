import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getDb } from '../db/init.js';
import { DATA_DIR } from '../config/defaults.js';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

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

  // Build list of files/dirs to include (relative to DATA_DIR)
  const includes = [];
  if (fs.existsSync(path.join(DATA_DIR, 'cidrella.db'))) includes.push('cidrella.db');
  else if (fs.existsSync(path.join(DATA_DIR, 'ipam.db'))) includes.push('ipam.db');
  if (fs.existsSync(path.join(DATA_DIR, 'certs'))) includes.push('certs');
  if (fs.existsSync(path.join(DATA_DIR, 'dnsmasq'))) includes.push('dnsmasq');

  if (includes.length === 0) {
    throw new Error('No data files found to backup');
  }

  execFileSync('tar', ['czf', archivePath, ...includes], {
    cwd: DATA_DIR,
    stdio: 'pipe',
    timeout: 60000
  });

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
    created_at: new Date().toISOString()
  };
}

/**
 * Restore from a backup archive
 */
export function restoreBackup(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error('Backup file not found');
  }

  // Validate archive contents
  const listing = execFileSync('tar', ['tzf', archivePath], { encoding: 'utf-8', timeout: 30000 });
  if (!listing.includes('cidrella.db') && !listing.includes('ipam.db')) {
    throw new Error('Invalid backup: missing database file');
  }

  // Extract to DATA_DIR, overwriting existing files
  execFileSync('tar', ['xzf', archivePath, '-C', DATA_DIR], {
    stdio: 'pipe',
    timeout: 60000
  });

  return { ok: true, message: 'Backup restored. Server restart required.' };
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
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'backup_retention_count'").get();
  const maxCount = parseInt(setting?.value || '7', 10);

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
      const schedule = db.prepare("SELECT value FROM settings WHERE key = 'backup_schedule'").get();
      if (!schedule || schedule.value === 'off') return;

      const interval = INTERVAL_MAP[schedule.value];
      if (!interval) return;

      const lastRun = db.prepare("SELECT value FROM settings WHERE key = 'backup_last_run'").get();
      const lastRunTime = lastRun ? new Date(lastRun.value).getTime() : 0;
      const now = Date.now();

      if (now - lastRunTime >= interval) {
        console.log(`Scheduled backup (${schedule.value})...`);
        createBackup(db);

        // Update last run time
        const nowStr = new Date().toISOString();
        if (lastRun) {
          db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_last_run'").run(nowStr);
        } else {
          db.prepare("INSERT INTO settings (key, value) VALUES ('backup_last_run', ?)").run(nowStr);
        }
        console.log('Scheduled backup completed');
      }
    } catch (err) {
      console.error('Scheduled backup failed:', err.message);
    }
  }, 15 * 60 * 1000);
}
