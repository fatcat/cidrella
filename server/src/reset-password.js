#!/usr/bin/env node
//
// CIDRella — CLI password reset
//
// Invoked via the /usr/local/bin/cidrella-reset-password wrapper (install.sh
// installs it at v0.4.8+). Sets a random password on a user account, marks
// the account as requiring a password change on next login, and writes an
// audit_log entry + populates the users.password_reset_by column so the
// legitimate account owner sees a visible trail on next successful login.
//
// Security model: this script is a convenience for a capability that already
// exists — anyone with write access to /var/lib/cidrella/cidrella.db can
// manipulate password_hash rows via any SQLite tooling. Hiding the script
// doesn't add security. The real boundary is filesystem access to the DB
// file, which v0.4.8 tightens to 600 cidrella:cidrella. The audit trail
// ensures that any use of this capability — legitimate or not — is visible
// to the legitimate account owner on their next login.
//
// Usage (via the wrapper):
//   sudo cidrella-reset-password            # resets 'admin'
//   sudo cidrella-reset-password someuser   # resets 'someuser'
//
// Exit codes:
//   0 — reset succeeded, new password printed to stdout
//   1 — user not found, database not found, or other fatal error

import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve DATA_DIR with a preference for real installs. Order:
//   1. Explicit DATA_DIR env var (caller overrides everything)
//   2. /var/lib/cidrella (native-install canonical path)
//   3. /data (Docker canonical path)
//   4. ../data (dev source-tree default)
// Whichever candidate has an existing cidrella.db wins. If none has one,
// we fail loudly rather than creating an empty DB in the dev tree.
function resolveDataDir() {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  const candidates = [
    '/var/lib/cidrella',
    '/data',
    path.join(__dirname, '..', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'cidrella.db'))) {
      return dir;
    }
  }
  return null;
}

const DATA_DIR = resolveDataDir();
if (!DATA_DIR) {
  console.error('');
  console.error('ERROR: could not locate cidrella.db');
  console.error('');
  console.error('Checked:');
  console.error('  $DATA_DIR (not set)');
  console.error('  /var/lib/cidrella/cidrella.db (native install)');
  console.error('  /data/cidrella.db (Docker)');
  console.error('  server/data/cidrella.db (dev)');
  console.error('');
  console.error('If your install uses a non-standard DATA_DIR, set it explicitly:');
  console.error('  sudo DATA_DIR=/path/to/data cidrella-reset-password <username>');
  console.error('');
  process.exit(1);
}

const dbPath = path.join(DATA_DIR, 'cidrella.db');
const username = process.argv[2] || 'admin';

let db;
try {
  db = new Database(dbPath);
} catch (err) {
  console.error(`ERROR: cannot open database at ${dbPath}: ${err.message}`);
  console.error('');
  console.error('Hint: the database is owned by the cidrella user and in v0.4.8+');
  console.error('has mode 600. Run this command via sudo:');
  console.error('  sudo cidrella-reset-password <username>');
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`ERROR: user "${username}" not found in ${dbPath}`);
  db.close();
  process.exit(1);
}

// Generate a new random password. 12 bytes → 16 base64url chars, plenty of
// entropy, URL-safe so it's easy to paste from a terminal without quoting.
const newPassword = crypto.randomBytes(12).toString('base64url');
const newHash = bcrypt.hashSync(newPassword, 10);

// Identify the OS actor performing this reset. This string is stored in
// users.password_reset_by and surfaced in the audit_log entry so the legit
// owner can see who did it on their next login.
const osUser = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
const hostname = os.hostname();
const tty = process.env.SSH_TTY || (process.stdin.isTTY ? 'tty' : 'no-tty');
const actorLabel = `cli:${osUser}@${hostname}`;

// Apply the reset + audit log atomically. If the audit insert fails for any
// schema-compat reason (e.g. running against a pre-044 DB), we still update
// the password but warn loudly. The password_reset_by column is guarded the
// same way — if it doesn't exist, we skip the update and warn.
const reset = db.transaction(() => {
  // Detect v0.4.8+ schema by checking for the password_reset_by column
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(r => r.name);
  const hasResetByCol = userCols.includes('password_reset_by');

  if (hasResetByCol) {
    db.prepare(`
      UPDATE users
         SET password_hash = ?,
             must_change_password = 1,
             password_reset_by = ?,
             updated_at = datetime('now')
       WHERE username = ?
    `).run(newHash, actorLabel, username);
  } else {
    db.prepare(`
      UPDATE users
         SET password_hash = ?,
             must_change_password = 1,
             updated_at = datetime('now')
       WHERE username = ?
    `).run(newHash, username);
  }

  // Audit log insert. Detect the audit_log schema — the columns vary across
  // older installs, so we introspect first and insert only what exists.
  const auditCols = db.prepare('PRAGMA table_info(audit_log)').all().map(r => r.name);
  if (auditCols.length === 0) {
    return { hasResetByCol, auditInserted: false };
  }
  const details = JSON.stringify({
    os_user: osUser,
    hostname,
    tty,
    target_user_id: user.id,
    target_username: username,
  });
  try {
    // Preferred shape (auditColumns guaranteed in v0.4.x): action, resource_type, details, created_at
    const cols = ['action', 'resource_type', 'details', 'created_at'];
    const vals = ['password_reset_cli', 'user', details, new Date().toISOString()];
    // Some schemas have user_id (the actor); set to NULL for CLI actions
    if (auditCols.includes('user_id')) {
      cols.unshift('user_id');
      vals.unshift(null);
    }
    // Some schemas have resource_id — set to the target user id
    if (auditCols.includes('resource_id')) {
      cols.push('resource_id');
      vals.push(String(user.id));
    }
    const placeholders = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO audit_log (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
    return { hasResetByCol, auditInserted: true };
  } catch (err) {
    return { hasResetByCol, auditInserted: false, auditError: err.message };
  }
});

const result = reset();
db.close();

console.log('');
console.log('========================================');
console.log(`  Password reset for: ${username}`);
console.log(`  New password:       ${newPassword}`);
console.log(`  (must change on next login)`);
console.log('========================================');
console.log('');
console.log(`  Actor recorded as:  ${actorLabel}`);
if (result.hasResetByCol) {
  console.log('  users.password_reset_by populated — legitimate account owner');
  console.log('  will see a warning banner on next successful login.');
} else {
  console.warn('  NOTE: this database predates v0.4.8 and does not have');
  console.warn('  users.password_reset_by. The reset is still in effect but');
  console.warn('  the next-login warning banner will not appear.');
}
if (result.auditInserted) {
  console.log('  audit_log entry written (action=password_reset_cli)');
} else if (result.auditError) {
  console.warn(`  NOTE: audit_log insert failed: ${result.auditError}`);
  console.warn('  The reset is in effect but the audit trail is incomplete.');
} else {
  console.warn('  NOTE: no audit_log table detected — no audit entry written.');
}
console.log('');
console.log('  Log in, go to Change Password, and set a real password immediately.');
console.log('');
