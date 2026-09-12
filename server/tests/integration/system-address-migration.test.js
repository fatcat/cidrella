import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];

function databaseThrough(targetVersion) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-system-address-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const apply = db.transaction((sql, version) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > targetVersion) continue;
    apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
  }
  return { db, apply };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('system address scope migration', () => {
  it('keeps topology addresses system and gives a CIDRella address ordinary DNS ownership', () => {
    const { db, apply } = databaseThrough(62);
    const subnet = db
      .prepare(
        `
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, domain_name
      ) VALUES ('10.88.0.0/24', 'System scope', '10.88.0.0', '10.88.0.255', 24,
                256, '10.88.0.1', 'example.test')
    `,
      )
      .run();
    const zone = db
      .prepare(
        `
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('example.test', 'forward', 1)
    `,
      )
      .run();
    const record = db
      .prepare(
        `
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'cidrella', 'A', '10.88.0.2', 'manual', 1)
    `,
      )
      .run(zone.lastInsertRowid);

    const insertAddress = db.prepare(`
      INSERT INTO ip_addresses (
        subnet_id, ip_address, hostname, mac_address, last_seen_at, is_online,
        reservation_note, detection_source, allocation_state,
        allocation_source_type, allocation_source_id, address_family,
        address_sort_key
      ) VALUES (?, ?, ?, ?, '2026-09-09 12:00:00', 1, ?, 'topology', 'system',
                'topology', ?, 4, ?)
    `);
    insertAddress.run(
      subnet.lastInsertRowid,
      '10.88.0.0',
      'network',
      null,
      'Protected network address',
      subnet.lastInsertRowid,
      '4:0a580000',
    );
    insertAddress.run(
      subnet.lastInsertRowid,
      '10.88.0.255',
      'broadcast',
      null,
      'Protected broadcast address',
      subnet.lastInsertRowid,
      '4:0a5800ff',
    );
    insertAddress.run(
      subnet.lastInsertRowid,
      '10.88.0.1',
      'gateway',
      null,
      'Protected system address',
      subnet.lastInsertRowid,
      '4:0a580001',
    );
    insertAddress.run(
      subnet.lastInsertRowid,
      '10.88.0.2',
      'old-cidrella',
      'aa:bb:cc:dd:ee:02',
      'Protected system address',
      subnet.lastInsertRowid,
      '4:0a580002',
    );
    insertAddress.run(
      subnet.lastInsertRowid,
      '10.88.0.3',
      'old-service',
      'aa:bb:cc:dd:ee:03',
      'Protected system address',
      subnet.lastInsertRowid,
      '4:0a580003',
    );

    const migration = fs.readFileSync(
      path.join(migrationsDir, '063_system_address_scope.sql'),
      'utf8',
    );
    apply(migration, 63);

    const rows = db
      .prepare(
        `
      SELECT ip_address, allocation_state, allocation_source_type,
             allocation_source_id, hostname, mac_address, last_seen_at,
             is_online, reservation_note, detection_source
      FROM ip_addresses
      WHERE subnet_id = ?
      ORDER BY address_sort_key
    `,
      )
      .all(subnet.lastInsertRowid);

    expect(rows).toEqual([
      expect.objectContaining({
        ip_address: '10.88.0.0',
        allocation_state: 'system',
        allocation_source_type: 'topology',
      }),
      expect.objectContaining({
        ip_address: '10.88.0.1',
        allocation_state: 'gateway',
        allocation_source_type: 'topology',
        allocation_source_id: subnet.lastInsertRowid,
      }),
      expect.objectContaining({
        ip_address: '10.88.0.2',
        allocation_state: 'static_dns',
        allocation_source_type: 'dns',
        allocation_source_id: record.lastInsertRowid,
        hostname: 'cidrella.example.test',
        mac_address: 'aa:bb:cc:dd:ee:02',
        last_seen_at: '2026-09-09 12:00:00',
        is_online: 1,
        reservation_note: null,
        detection_source: 'dns',
      }),
      expect.objectContaining({
        ip_address: '10.88.0.3',
        allocation_state: 'unassigned',
        allocation_source_type: null,
        allocation_source_id: null,
        hostname: null,
        mac_address: 'aa:bb:cc:dd:ee:03',
        last_seen_at: '2026-09-09 12:00:00',
        is_online: 1,
        reservation_note: null,
        detection_source: null,
      }),
      expect.objectContaining({
        ip_address: '10.88.0.255',
        allocation_state: 'system',
        allocation_source_type: 'topology',
      }),
    ]);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version).toBe(63);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
