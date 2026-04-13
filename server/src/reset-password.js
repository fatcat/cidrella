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

// Detect whether the DB has the v0.4.8 password_reset_by column. On pre-v0.4.8
// DBs (which a user might hit if they're resetting a password on a legacy
// install that was never upgraded), the column doesn't exist and we gracefully
// skip writing it — the password reset itself still succeeds, just without
// the banner trail. This is the ONLY place in reset-password.js that needs
// runtime schema introspection; elsewhere we use the known canonical schema
// directly. Do the check once, up front, outside the transaction.
const userCols = db.prepare('PRAGMA table_info(users)').all().map(r => r.name);
const hasResetByCol = userCols.includes('password_reset_by');

// Apply the reset + audit log atomically. The audit_log schema is canonical
// (created by migration 001 and stable since): id, user_id, action,
// entity_type, entity_id, details, created_at. There's no need to introspect
// it — we're in a codebase where migrations always run before any non-CLI
// code, and this CLI opens the DB without running migrations, but the
// audit_log has existed since day one so the CLI can assume it.
const reset = db.transaction(() => {
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

  // Audit log INSERT uses the canonical schema. user_id is NULL because the
  // actor is not a CIDRella user — it's an OS-level root with shell access.
  // The actor label goes into details.
  const details = JSON.stringify({
    os_user: osUser,
    hostname,
    tty,
    target_user_id: user.id,
    target_username: username,
    actor_label: actorLabel,
  });
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
    ).run(null, 'password_reset_cli', 'user', user.id, details);
    return { auditInserted: true };
  } catch (err) {
    return { auditInserted: false, auditError: err.message };
  }
});

const result = reset();
result.hasResetByCol = hasResetByCol;
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
