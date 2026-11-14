import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openProxyDb,
  closeProxyDb,
  proxyDb,
  setSettingDefaults,
  setting,
  cachedSetting,
  clearSettingCache,
} from '../../../src/dns-proxy/db.js';

let dir;
let file;
let writer;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-db-'));
  file = path.join(dir, 'cidrella.db');
  writer = new Database(file);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  setSettingDefaults({ dnssec_enabled: 'false', dns_upstream_servers: ['9.9.9.9'] });
  openProxyDb(file);
});

afterEach(() => {
  closeProxyDb();
  writer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (key, value) =>
  writer.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

describe("the DNS proxy's database", () => {
  it('reads settings as db/init does: JSON keys parsed, defaults when absent', () => {
    expect(setting('dnssec_enabled')).toBe('false');
    expect(setting('dns_upstream_servers')).toEqual(['9.9.9.9']);
    put('dns_upstream_servers', JSON.stringify(['1.1.1.1', '2606:4700:4700::1111']));
    put('dnssec_enabled', 'true');
    expect(setting('dns_upstream_servers')).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
    expect(setting('dnssec_enabled')).toBe('true');
  });

  it('is read-only', () => {
    expect(() => proxyDb().prepare("INSERT INTO settings VALUES ('a', 'b')").run()).toThrow(
      /readonly/i,
    );
  });

  it('keeps a value for 2 s for a query, and reads the table for a loader', () => {
    put('dnssec_enabled', 'true');
    const t0 = Date.now();
    expect(cachedSetting('dnssec_enabled', t0)).toBe('true');
    put('dnssec_enabled', 'false');
    expect(cachedSetting('dnssec_enabled', t0 + 1000)).toBe('true');
    expect(cachedSetting('dnssec_enabled', t0 + 2500)).toBe('false');
    put('dnssec_enabled', 'true');
    expect(setting('dnssec_enabled')).toBe('true');
    clearSettingCache();
    expect(cachedSetting('dnssec_enabled')).toBe('true');
  });

  it("never waits on the web app's write lock", () => {
    writer.exec('BEGIN IMMEDIATE');
    put('dnssec_enabled', 'true');
    const started = Date.now();
    // A writer holding the lock does not block a WAL reader; it sees the
    // last committed value.
    expect(setting('dnssec_enabled')).toBe('false');
    expect(Date.now() - started).toBeLessThan(100);
    writer.exec('COMMIT');
    expect(setting('dnssec_enabled')).toBe('true');
  });

  it('keeps the last value it read when a read fails, and defaults with no database', () => {
    put('dnssec_enabled', 'true');
    expect(setting('dnssec_enabled')).toBe('true');
    proxyDb().close();
    expect(setting('dnssec_enabled')).toBe('true');
    closeProxyDb();
    expect(proxyDb()).toBeNull();
    expect(setting('dnssec_enabled')).toBe('false');
  });
});
