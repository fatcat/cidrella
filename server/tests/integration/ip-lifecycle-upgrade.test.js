import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../../src/db/init.js';
import {
  inventoryLegacyIpLifecycle,
  LIFECYCLE_MIGRATION_REPORT,
  writeLifecycleMigrationReport
} from '../../src/db/ip-lifecycle-upgrade.js';
import { seedLegacyLifecycleContradictions } from '../fixtures/ip-lifecycle-0_4_17.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];

function legacyDatabase() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-lifecycle-upgrade-'));
  tmpDirs.push(tmpDir);
  const dbPath = path.join(tmpDir, 'cidrella.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const apply = db.transaction((sql, version) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });
  for (const file of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > 54) continue;
    apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
  }
  return { db, dbPath, tmpDir };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('0.4.17 IP lifecycle upgrade', () => {
  it('inventories ambiguous claims and blocks before schema mutation', async () => {
    const { db, dbPath, tmpDir } = legacyDatabase();
    const { zoneId } = seedLegacyLifecycleContradictions(db);
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'first-name', 'A', '10.77.0.10', 'manual', 1),
             (?, 'second-name', 'A', '10.77.0.10', 'manual', 1)
    `).run(zoneId, zoneId);
    const inventory = inventoryLegacyIpLifecycle(db, { localAddresses: new Set() });
    expect(inventory.summary.blocking_conflicts).toBeGreaterThan(0);
    expect(inventory.conflicts.map(conflict => conflict.category)).toEqual(expect.arrayContaining([
      'locked_address_with_protocol_claim',
      'competing_dns_and_dhcp_reservation',
      'duplicate_canonical_identity',
      'multiple_static_dns_names',
      'unscoped_ipv6_link_local'
    ]));
    expect(inventory.summary.ips_with_multiple_static_dns_names).toBe(1);
    expect(inventory.conflicts.find(conflict => conflict.category === 'multiple_static_dns_names'))
      .toMatchObject({
        ip_address: '10.77.0.10',
        reason: expect.stringContaining('first-name.legacy.test'),
        remediation: expect.stringContaining('CNAME')
      });
    db.close();

    await expect(initDb(tmpDir)).rejects.toThrow(/migration blocked/);
    const unchanged = new Database(dbPath, { readonly: true });
    expect(unchanged.prepare('SELECT MAX(version) AS version FROM schema_version').get().version).toBe(54);
    unchanged.close();

    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, LIFECYCLE_MIGRATION_REPORT), 'utf8'));
    expect(report).toMatchObject({ schema_before: 54, outcome: 'blocked', policy: 'block' });
    expect(report.conflicts[0]).toMatchObject({ remediation: expect.any(String) });
  });

  it('reconciles safe legacy state and removes compatibility storage at schema 59', async () => {
    const { db, tmpDir } = legacyDatabase();
    const { subnetId, zoneId } = seedLegacyLifecycleContradictions(db);

    // Resolve the deliberately ambiguous fixture claims without deleting the
    // protocol rows whose disabled state must survive the upgrade.
    db.prepare("DELETE FROM dhcp_leases WHERE ip_address = '10.77.0.40'").run();
    db.prepare("UPDATE dns_records SET enabled = 0 WHERE zone_id = ? AND name = 'dns-host'").run(zoneId);
    db.prepare("DELETE FROM ip_addresses WHERE ip_address IN ('2001:0db8:0:0:0:0:0:60', 'fe80::1')").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-host', 'A', '10.77.0.10', 'manual', 1)
    `).run(zoneId);
    db.prepare(`
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '10.77.0.30', 'aa:bb:cc:dd:ee:30', 'dynamic-host', 'infinite')
    `).run(subnetId);
    db.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let upgraded;
    try {
      upgraded = await initDb(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get().version).toBe(59);
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.prepare("SELECT allocation_state, is_rogue FROM ip_addresses WHERE ip_address = '10.77.0.40'").get())
      .toEqual({ allocation_state: 'reserved', is_rogue: 0 });
    expect(upgraded.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.77.0.50'").get().allocation_state)
      .toBe('static_dhcp');
    expect(upgraded.prepare("SELECT allocation_state, detection_source FROM ip_addresses WHERE ip_address = '10.77.0.70'").get())
      .toEqual({ allocation_state: 'unassigned', detection_source: null });
    expect(upgraded.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.77.0.71'").get())
      .toMatchObject({ allocation_state: 'unassigned' });
    expect(upgraded.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.77.0.10'").get().allocation_state)
      .toBe('static_dns');
    expect(upgraded.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.77.0.30'").get().allocation_state)
      .toBe('dynamic_dhcp');
    expect(upgraded.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.77.0.1'").get().allocation_state)
      .toBe('gateway');
    expect(upgraded.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name))
      .not.toContain('status');
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM dns_records WHERE zone_id = ?").get(zoneId).count)
      .toBeGreaterThan(0);

    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, LIFECYCLE_MIGRATION_REPORT), 'utf8'));
    expect(report).toMatchObject({
      schema_before: 54,
      schema_after: 59,
      outcome: 'complete',
      reconciliation: { inserted: expect.any(Number), updated: expect.any(Number) }
    });
    upgraded.close();
  });

  it('retries reconciliation after migrations completed on an interrupted startup', async () => {
    const { db, tmpDir } = legacyDatabase();
    const { subnetId, zoneId } = seedLegacyLifecycleContradictions(db);
    db.prepare("DELETE FROM dhcp_leases WHERE ip_address = '10.77.0.40'").run();
    db.prepare("UPDATE dns_records SET enabled = 0 WHERE zone_id = ? AND name = 'dns-host'").run(zoneId);
    db.prepare("DELETE FROM ip_addresses WHERE ip_address IN ('2001:0db8:0:0:0:0:0:60', 'fe80::1')").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-host', 'A', '10.77.0.10', 'manual', 1)
    `).run(zoneId);

    const report = inventoryLegacyIpLifecycle(db, { localAddresses: new Set() });
    expect(report.summary.blocking_conflicts).toBe(0);
    writeLifecycleMigrationReport(tmpDir, {
      ...report,
      schema_before: 54,
      outcome: 'ready'
    });

    const apply = db.transaction((sql, version) => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    for (const file of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
      const version = Number.parseInt(file.split('_')[0], 10);
      if (version <= 54) continue;
      apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
    }
    db.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let recovered;
    try {
      recovered = await initDb(tmpDir);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }

    expect(recovered.prepare(`
      SELECT allocation_state FROM ip_addresses
      WHERE subnet_id = ? AND ip_address = '10.77.0.10'
    `).get(subnetId).allocation_state).toBe('static_dns');
    const completed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, LIFECYCLE_MIGRATION_REPORT), 'utf8')
    );
    expect(completed).toMatchObject({
      schema_before: 54,
      schema_after: 59,
      outcome: 'complete',
      reconciliation: { updated: expect.any(Number), inserted: expect.any(Number) }
    });
    recovered.close();

    fs.writeFileSync(path.join(tmpDir, LIFECYCLE_MIGRATION_REPORT), '{invalid json\n');
    const invalidWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(initDb(tmpDir)).rejects.toThrow(/migration report .* is unreadable/);
    } finally {
      invalidWarn.mockRestore();
    }
  });
});
