#!/usr/bin/env node
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = path.join(DATA_DIR, 'cidrella.db');

const username = process.argv[2] || 'admin';

const db = new Database(dbPath);
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (!user) {
  console.error(`User "${username}" not found.`);
  process.exit(1);
}

const password = crypto.randomBytes(12).toString('base64url');
const hash = bcrypt.hashSync(password, 10);

db.prepare(
  "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE username = ?"
).run(hash, username);

db.close();

console.log('');
console.log('========================================');
console.log(`  Password reset for: ${username}`);
console.log(`  New password: ${password}`);
console.log('  (must change on next login)');
console.log('========================================');
console.log('');
