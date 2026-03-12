import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, getDb } from '../../src/db/init.js';

/**
 * Create a fresh test database in a temp directory with all migrations applied.
 * Returns { db, tmpDir } — call cleanupTestDb(tmpDir) when done.
 */
export async function setupTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-'));

  // initDb migrations may reference DATA_DIR-relative paths; create expected subdirs
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'dhcp-hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'certs'), { recursive: true });

  // Set DATA_DIR so any code that reads it gets the temp directory
  process.env.DATA_DIR = tmpDir;

  await initDb(tmpDir);
  return { db: getDb(), tmpDir };
}

/**
 * Remove the temp directory created by setupTestDb.
 */
export function cleanupTestDb(tmpDir) {
  if (tmpDir && tmpDir.includes('cidrella-test-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
