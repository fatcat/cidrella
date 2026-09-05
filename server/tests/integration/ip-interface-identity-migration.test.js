import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../../src/db/init.js';
import * as IpAddress from '../../src/models/ip-address.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
let tmpDir;
let db;

function applyMigrationsThrough(database, maxVersion) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const apply = database.transaction((sql, version) => {
    database.exec(sql);
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });
  for (const file of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) continue;
    apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
  }
}

afterAll(() => {
  if (db?.open) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrations 057-059 canonical IP identity', () => {
  it('preserves addresses and events while removing legacy status storage', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-identity-migration-'));
    const dbPath = path.join(tmpDir, 'cidrella.db');
    const legacyDb = new Database(dbPath);
    legacyDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(legacyDb, 56);

    const subnetId = legacyDb.prepare(`
      INSERT INTO subnets
        (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, status)
      VALUES ('10.77.0.0/24', 'Identity migration', '10.77.0.0',
              '10.77.0.255', 24, 256, 'allocated')
    `).run().lastInsertRowid;
    const addressId = legacyDb.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, description, status, allocation_state,
         address_family, address_sort_key)
      VALUES (?, '10.77.0.42', 'preserved-host', 'operator note', 'assigned',
              'static_dns', 4, '40000000000000000000000000a4d002a')
    `).run(subnetId).lastInsertRowid;
    legacyDb.prepare(`
      INSERT INTO ip_events
        (ip_address_id, subnet_id, ip_address, event_type, old_value, new_value, source)
      VALUES (?, ?, '10.77.0.42', 'status_changed', 'available', 'assigned', 'manual')
    `).run(addressId, subnetId);
    legacyDb.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      db = await initDb(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(db.prepare("SELECT * FROM ip_addresses WHERE ip_address = '10.77.0.42'").get())
      .toMatchObject({
        id: addressId,
        hostname: 'preserved-host',
        description: 'operator note',
        allocation_state: 'static_dns'
      });
    expect(db.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name))
      .not.toContain('status');
    expect(db.prepare('SELECT * FROM ip_events WHERE ip_address_id = ?').get(addressId))
      .toMatchObject({
        subnet_id: subnetId,
        ip_address: '10.77.0.42',
        event_type: 'status_changed',
        old_value: 'available',
        new_value: 'assigned',
        source: 'manual'
      });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version)
      .toBe(59);
    expect(db.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name))
      .toEqual(expect.arrayContaining(['dhcp_duid', 'dhcp_iaid']));

    const eth0Id = IpAddress.upsert(db, subnetId, 'fe80::42%eth0', {});
    const eth1Id = IpAddress.upsert(db, subnetId, 'fe80::42%eth1', {});
    expect(eth1Id).not.toBe(eth0Id);
    expect(db.prepare("SELECT interface_id FROM ip_addresses WHERE ip_address = 'fe80::42' ORDER BY interface_id").all())
      .toEqual([{ interface_id: 'eth0' }, { interface_id: 'eth1' }]);
  });
});
