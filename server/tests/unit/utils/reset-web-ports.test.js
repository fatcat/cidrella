import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('reset-web-ports CLI helper', () => {
  it('clears web port overrides and re-enables HTTP redirect', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-reset-web-ports-'));
    try {
      const dbPath = path.join(tmpDir, 'cidrella.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO settings (key, value) VALUES
          ('https_port', '9443'),
          ('http_port', '9080'),
          ('http_redirect_enabled', 'false');
      `);
      db.close();

      execFileSync(process.execPath, ['src/reset-web-ports.js'], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, DATA_DIR: tmpDir },
        stdio: 'pipe'
      });

      const checkDb = new Database(dbPath, { readonly: true });
      try {
        expect(checkDb.prepare("SELECT value FROM settings WHERE key = 'https_port'").get().value).toBe('');
        expect(checkDb.prepare("SELECT value FROM settings WHERE key = 'http_port'").get().value).toBe('');
        expect(checkDb.prepare("SELECT value FROM settings WHERE key = 'http_redirect_enabled'").get().value).toBe('true');
      } finally {
        checkDb.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
