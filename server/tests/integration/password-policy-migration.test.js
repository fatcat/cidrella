/**
 * Migration 076: the one-switch password_complexity becomes the four policy
 * settings, and DHCP's default flips to off for fresh databases only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

const setting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 076', () => {
  it('converts a switched-off complexity flag into the two parts it meant, and drops the key', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    db.prepare("INSERT INTO settings (key, value) VALUES ('password_complexity', 'false')").run();
    migrate(76);
    expect(setting(db, 'password_require_mixed_case')).toBe('false');
    expect(setting(db, 'password_require_number')).toBe('false');
    expect(setting(db, 'password_require_symbol')).toBeNull();
    expect(setting(db, 'password_min_length')).toBeNull();
    expect(setting(db, 'password_complexity')).toBeNull();
  });

  it('writes nothing for a flag that was on, beyond removing it', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    db.prepare("INSERT INTO settings (key, value) VALUES ('password_complexity', 'true')").run();
    migrate(76);
    expect(setting(db, 'password_require_mixed_case')).toBeNull();
    expect(setting(db, 'password_complexity')).toBeNull();
  });

  it('keeps DHCP on for an install that has a network', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    db.prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, depth) VALUES ('10.9.0.0/24', 'lan', '10.9.0.0', '10.9.0.255', 24, 256, 'allocated', 0)`,
    ).run();
    migrate(76);
    expect(setting(db, 'dhcp_enabled')).toBe('true');
  });

  it('keeps DHCP on for an install whose admin has changed their password', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 0)",
    ).run();
    migrate(76);
    expect(setting(db, 'dhcp_enabled')).toBe('true');
  });

  it('turns DHCP off for a fresh database, which migration 033 had seeded on', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    expect(setting(db, 'dhcp_enabled')).toBe('true');
    migrate(76);
    expect(setting(db, 'dhcp_enabled')).toBe('false');
  });

  it('keeps the seed for a database that finished setup without a network or login', () => {
    const { db, migrate } = databaseThrough(75, { tmpDirs });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('setup_state', '{"done":true}')`).run();
    migrate(76);
    expect(setting(db, 'dhcp_enabled')).toBe('true');
  });
});
