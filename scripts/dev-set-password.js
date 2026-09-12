#!/usr/bin/env node
/*
 * Dev-only: set the local admin password to a known value.
 *
 * A fresh dev database prints a random admin password exactly once, on first
 * boot. Miss that line in the scrollback and you are locked out of your own
 * dev tree with no recovery path short of deleting the DB. This resets it to
 * something you can type.
 *
 * It is deliberately NOT usable against a real install. The database path is
 * the repo's own server/data/cidrella.db, computed from this file's location,
 * and DATA_DIR is ignored on purpose so there is no env var that can point a
 * known weak password at production. For a real install use
 * cidrella-reset-password, which generates a random password, requires a
 * change on next login, and writes an audit trail.
 *
 * Usage:
 *   node scripts/dev-set-password.js [username]
 *   DEV_ADMIN_PASSWORD=something-else node scripts/dev-set-password.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'server', 'data', 'cidrella.db');

// Default dev credential. Weak on purpose: this only ever reaches a dev DB in
// a working tree, and the guards below are what keep it there.
const DEFAULT_PASSWORD = 'r3yn0ld5';

// Refuse to run from anywhere that looks like a deployed appliance, in case
// someone ever unpacks or clones this tree into a slot. The DB_PATH check
// above already scopes us to the repo, this catches "the repo IS the install".
const FORBIDDEN_ROOTS = ['/opt/cidrella', '/var/lib/cidrella', '/data'];
for (const forbidden of FORBIDDEN_ROOTS) {
  if (ROOT === forbidden || ROOT.startsWith(`${forbidden}/`) || DB_PATH.startsWith(`${forbidden}/`)) {
    console.error(`refusing to run: ${ROOT} looks like a real install, not a dev tree.`);
    console.error('Use cidrella-reset-password there instead.');
    process.exit(1);
  }
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`no dev database at ${DB_PATH}`);
  console.error('Start the dev backend once so it creates and migrates the DB, then retry.');
  process.exit(1);
}

// better-sqlite3 and bcryptjs are server/ dependencies, and this script lives
// in scripts/, so plain require() would walk up to the root node_modules and
// miss them. Resolve from server/ explicitly.
function serverRequire(name) {
  return require(require.resolve(name, { paths: [path.join(ROOT, 'server')] }));
}

let Database;
let bcrypt;
try {
  Database = serverRequire('better-sqlite3');
  bcrypt = serverRequire('bcryptjs');
} catch (err) {
  console.error(`cannot load server dependencies: ${err.message}`);
  console.error('Run `npm install` in server/ first.');
  process.exit(1);
}

const username = process.argv[2] || 'admin';
const password = process.env.DEV_ADMIN_PASSWORD || DEFAULT_PASSWORD;

const db = new Database(DB_PATH);
try {
  const hash = bcrypt.hashSync(password, 10);

  // must_change_password = 0 is the whole point: a dev logging in with a
  // password they just set should land on the app, not a change-password wall.
  const result = db.prepare(`
    UPDATE users
       SET password_hash = ?,
           must_change_password = 0,
           updated_at = datetime('now')
     WHERE username = ?
  `).run(hash, username);

  if (result.changes === 0) {
    const known = db.prepare('SELECT username FROM users ORDER BY id').all().map(r => r.username);
    console.error(`user "${username}" not found in ${DB_PATH}`);
    console.error(known.length ? `Known users: ${known.join(', ')}` : 'The users table is empty.');
    process.exit(1);
  }

  const shown = process.env.DEV_ADMIN_PASSWORD ? '(from DEV_ADMIN_PASSWORD)' : password;
  console.log(`dev login: ${username} / ${shown}`);
} finally {
  db.close();
}
