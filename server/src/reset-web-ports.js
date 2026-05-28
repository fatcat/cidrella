#!/usr/bin/env node
import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config/defaults.js';
import { upsertSettings } from './models/setting.js';

const dbPath = process.env.CIDRELLA_DB || path.join(DATA_DIR, 'cidrella.db');

function readSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

const db = new Database(dbPath);
try {
  const before = {
    https_port: readSetting(db, 'https_port'),
    http_port: readSetting(db, 'http_port'),
    http_redirect_enabled: readSetting(db, 'http_redirect_enabled')
  };

  upsertSettings(db, [
    ['https_port', ''],
    ['http_port', ''],
    ['http_redirect_enabled', 'true']
  ]);

  console.log(`CIDRella web port settings reset in ${dbPath}`);
  console.log(`Previous https_port: ${before.https_port || '(default)'}`);
  console.log(`Previous http_port: ${before.http_port || '(default)'}`);
  console.log(`Previous http_redirect_enabled: ${before.http_redirect_enabled || '(default)'}`);
} finally {
  db.close();
}
