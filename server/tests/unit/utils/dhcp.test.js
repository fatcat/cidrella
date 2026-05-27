import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/utils/after-commit.js', () => ({
  queueRegen: vi.fn()
}));

let db;
let tmpDir;
let subnetId;
let scopeId;
let zoneId;
let syncDhcpDnsRecords;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  ({ syncDhcpDnsRecords } = await import('../../../src/models/dhcp-lease.js'));

  db.prepare(`
    INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status, domain_name)
    VALUES ('10.0.1.0/24', 'DHCP DNS', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated', 'example.test')
  `).run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.1.0/24'").get().id;

  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const range = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, '10.0.1.20', '10.0.1.200')
  `).run(subnetId, rangeTypeId);

  const scope = db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time)
    VALUES (?, ?, '24h')
  `).run(range.lastInsertRowid, subnetId);
  scopeId = scope.lastInsertRowid;

  const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
  zoneId = zone.lastInsertRowid;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dhcp_reservations').run();
  db.prepare('UPDATE dhcp_scopes SET enabled = 1 WHERE id = ?').run(scopeId);
});

describe('syncDhcpDnsRecords', () => {
  it('creates DHCP-sourced A records for dynamic leases with hostnames', () => {
    syncDhcpDnsRecords(db, [{
      ip: '10.0.1.50',
      mac: 'aa:bb:cc:dd:ee:50',
      hostname: 'lease-host',
      subnetId
    }]);

    const row = db.prepare(`
      SELECT name, type, value, source, enabled
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.50'
    `).get(zoneId);

    expect(row).toEqual({
      name: 'lease-host',
      type: 'A',
      value: '10.0.1.50',
      source: 'dhcp',
      enabled: 1
    });
  });

  it('keeps reservation hostname over dynamic lease hostname for the same IP', () => {
    db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.0.1.51', 'aa:bb:cc:dd:ee:51', 'reserved-host', 1)
    `).run(subnetId);

    syncDhcpDnsRecords(db, [{
      ip: '10.0.1.51',
      mac: 'aa:bb:cc:dd:ee:51',
      hostname: 'lease-host',
      subnetId
    }]);

    const row = db.prepare(`
      SELECT name, value, source
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.51'
    `).get(zoneId);

    expect(row).toEqual({
      name: 'reserved-host',
      value: '10.0.1.51',
      source: 'reservation'
    });
  });
});
