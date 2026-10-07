/**
 * Migration 084: saved encrypted upstreams that came from the AdGuard preset
 * move from unfiltered.dns.adguard-dns.com (which does not resolve) to
 * unfiltered.adguard-dns.com. Other upstreams and settings are untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOH_PROVIDERS } from '../../src/data/doh-providers.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const migration = fs.readFileSync(
  path.join(migrationsDir, '084_adguard_upstream_hostname.sql'),
  'utf8',
);
const tmpDirs = [];

function settingsDb(value) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-adguard-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('forwarder_encrypted_upstreams', ?)").run(
    value,
  );
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('other', 'unfiltered.dns.adguard-dns.com')",
  ).run();
  return db;
}

const read = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 084', () => {
  it('moves a saved AdGuard upstream to the working name and leaves the rest alone', () => {
    const saved = [
      {
        addresses: ['1.1.1.1'],
        hostname: 'cloudflare-dns.com',
        doh_url: 'https://cloudflare-dns.com/dns-query',
      },
      {
        addresses: ['94.140.14.140', '2a10:50c0::1:ff'],
        hostname: 'unfiltered.dns.adguard-dns.com',
        doh_url: 'https://unfiltered.dns.adguard-dns.com/dns-query',
      },
    ];
    const db = settingsDb(JSON.stringify(saved));
    db.exec(migration);
    expect(JSON.parse(read(db, 'forwarder_encrypted_upstreams'))).toEqual([
      saved[0],
      {
        addresses: ['94.140.14.140', '2a10:50c0::1:ff'],
        hostname: 'unfiltered.adguard-dns.com',
        doh_url: 'https://unfiltered.adguard-dns.com/dns-query',
      },
    ]);
    expect(read(db, 'other')).toBe('unfiltered.dns.adguard-dns.com');
  });

  it('matches the preset the UI now offers', () => {
    const adguard = DOH_PROVIDERS.find((p) => p.id === 'adguard');
    const db = settingsDb(
      JSON.stringify([
        {
          ...adguard,
          hostname: 'unfiltered.dns.adguard-dns.com',
          doh_url: 'https://unfiltered.dns.adguard-dns.com/dns-query',
        },
      ]),
    );
    db.exec(migration);
    const [migrated] = JSON.parse(read(db, 'forwarder_encrypted_upstreams'));
    expect(migrated.hostname).toBe(adguard.hostname);
    expect(migrated.doh_url).toBe(adguard.doh_url);
  });
});
