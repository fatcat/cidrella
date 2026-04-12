import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { DEFAULTS } from '../config/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Read a setting from the database, falling back to DEFAULTS.
 * For JSON-stored settings (dns_upstream_servers, dns_soa_defaults),
 * the value is automatically parsed.
 */
export function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  const raw = row?.value;

  // JSON-stored keys
  if (key === 'dns_upstream_servers' || key === 'dns_soa_defaults') {
    try {
      return raw ? JSON.parse(raw) : DEFAULTS[key];
    } catch {
      return DEFAULTS[key];
    }
  }

  // Numeric keys
  if (key === 'audit_log_retention_days') {
    return raw != null ? parseInt(raw, 10) : DEFAULTS[key];
  }

  // String keys — return DB value or default
  if (raw != null) return raw;
  return DEFAULTS[key] ?? null;
}

export async function initDb(dataDir) {
  const dbPath = path.join(dataDir, 'cidrella.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations();
  await ensureDefaults();

  return db;
}

function runMigrations() {
  // Create schema_version table if it doesn't exist
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Max version this code version ships with
  const codeMaxVersion = migrationFiles.reduce((max, file) => {
    const v = parseInt(file.split('_')[0], 10);
    return v > max ? v : max;
  }, 0);

  // Check for schema-too-new — prevents running old code against a new DB
  // (which happens after an unsafe rollback that didn't restore the DB snapshot).
  const dbMaxVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  if (dbMaxVersion > codeMaxVersion) {
    console.error('');
    console.error('========================================');
    console.error('  DATABASE SCHEMA INCOMPATIBLE');
    console.error('========================================');
    console.error(`  DB schema version:   ${dbMaxVersion}`);
    console.error(`  Code max supported:  ${codeMaxVersion}`);
    console.error('');
    console.error('  This code is older than the database schema.');
    console.error('  This usually means a rollback occurred without');
    console.error('  restoring the database snapshot.');
    console.error('');
    console.error('  Fix: run cidrella-rollback --restore-db');
    console.error('  Or:  update to a newer CIDRella version');
    console.error('========================================');
    console.error('');
    throw new Error(`Schema v${dbMaxVersion} is newer than code max v${codeMaxVersion}`);
  }

  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );

  // Run each migration in a transaction so partial applies can't corrupt the schema
  const applyMigration = db.transaction((sql, version) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });

  let newCount = 0;
  for (const file of migrationFiles) {
    const version = parseInt(file.split('_')[0], 10);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    applyMigration(sql, version);
    console.log(`Applied migration: ${file}`);
    newCount++;
  }

  const currentVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v ?? 0;
  if (newCount > 0) {
    console.log(`Schema version: ${currentVersion} (applied ${newCount} new migration${newCount !== 1 ? 's' : ''})`);
  } else {
    console.log(`Schema version: ${currentVersion} (up to date)`);
  }
}

export async function ensureDefaults() {
  // Generate JWT secret if not present
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  if (!existing) {
    const secret = crypto.randomBytes(64).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
    console.log('Generated JWT secret');
  }

  // Seed every key in DEFAULTS that doesn't already have a DB row
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    insert.run(key, serialized);
  }

  // Create default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const password = crypto.randomBytes(12).toString('base64url');
    const hash = await bcrypt.hash(password, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)'
    ).run('admin', hash, 'admin');

    console.log('');
    console.log('========================================');
    console.log('  Default admin account created');
    console.log(`  Username: admin`);
    console.log(`  Password: ${password}`);
    console.log('========================================');
    console.log('');
  }
}

/**
 * Upsert a setting. Standardized across the codebase.
 */
export function setSetting(key, value) {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

export function audit(userId, action, entityType, entityId, details) {
  const detailsJson = details ? JSON.stringify(details) : null;
  db.prepare(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, action, entityType, entityId, detailsJson);
}
