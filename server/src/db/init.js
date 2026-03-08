import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
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

  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );

  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

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

  // Set default gateway preference
  const gwPref = db.prepare("SELECT value FROM settings WHERE key = 'default_gateway_position'").get();
  if (!gwPref) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('default_gateway_position', 'first')").run();
  }

  // Set default subnet name template
  const tmpl = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
  if (!tmpl) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('subnet_name_template', '%1.%2.%3.%4/%bitmask')").run();
  }

  // Set default DNS upstream servers
  const dnsUp = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();
  if (!dnsUp) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('dns_upstream_servers', ?)").run(JSON.stringify(['8.8.8.8', '1.1.1.1']));
  }

  // Blocklist defaults
  const blEnabled = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_enabled'").get();
  if (!blEnabled) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('blocklist_enabled', 'true')").run();
  }
  const blRedirect = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_redirect_ip'").get();
  if (!blRedirect) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('blocklist_redirect_ip', '')").run();
  }
  const blSchedule = db.prepare("SELECT value FROM settings WHERE key = 'blocklist_update_schedule'").get();
  if (!blSchedule) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('blocklist_update_schedule', 'daily')").run();
  }

  // Backup defaults
  const bkSched = db.prepare("SELECT value FROM settings WHERE key = 'backup_schedule'").get();
  if (!bkSched) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('backup_schedule', 'off')").run();
  }
  const bkRetention = db.prepare("SELECT value FROM settings WHERE key = 'backup_retention_count'").get();
  if (!bkRetention) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('backup_retention_count', '7')").run();
  }

  // Installation state
  const installComplete = db.prepare("SELECT value FROM settings WHERE key = 'installation_complete'").get();
  if (!installComplete) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('installation_complete', 'false')").run();
  }

  // GeoIP defaults
  const geoipDefaults = {
    geoip_enabled: 'false',
    geoip_mode: 'blocklist',
    geoip_proxy_port: '5353',
    geoip_db_path: '/data/geoip/dbip-country-lite.mmdb',
    geoip_last_updated: '',
    geoip_update_schedule: 'monthly'
  };
  for (const [key, value] of Object.entries(geoipDefaults)) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
    }
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

export function audit(userId, action, entityType, entityId, details) {
  const detailsJson = details ? JSON.stringify(details) : null;
  db.prepare(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, action, entityType, entityId, detailsJson);
}
