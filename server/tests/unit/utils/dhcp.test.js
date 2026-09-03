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
let reverseZoneId;
let syncDhcpDnsRecords;
let replaceLeases;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  ({ syncDhcpDnsRecords, replaceLeases } = await import('../../../src/models/dhcp-lease.js'));

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
  reverseZoneId = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('1.0.10.in-addr.arpa', 'reverse', 1)")
    .run().lastInsertRowid;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM ip_events').run();
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dhcp_reservations').run();
  db.prepare('UPDATE dhcp_scopes SET enabled = 1 WHERE id = ?').run(scopeId);
});

describe('replaceLeases', () => {
  it('keeps a vanished lease as expired identity until offline retirement', () => {
    const lease = {
      ip: '10.0.1.54',
      mac: 'aa:bb:cc:dd:ee:54',
      hostname: 'departed-host',
      clientId: 'client-54',
      expiresAt: 'infinite',
      subnetId
    };
    replaceLeases(db, [lease]);

    replaceLeases(db, []);

    const retained = db.prepare(`
      SELECT *, datetime(expires_at) <= datetime('now') AS expired
      FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?
    `).get(subnetId, lease.ip);
    expect(retained).toMatchObject({
      mac_address: lease.mac,
      hostname: lease.hostname,
      client_id: lease.clientId,
      expired: 1
    });
    expect(db.prepare('SELECT allocation_state FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
      .get(subnetId, lease.ip).allocation_state).toBe('unassigned');
  });
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

    const ptr = db.prepare(`
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '50'
    `).get(reverseZoneId);

    expect(ptr.value).toBe('lease-host.example.test');
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

    const ptr = db.prepare(`
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '51'
    `).get(reverseZoneId);

    expect(ptr.value).toBe('reserved-host.example.test');
  });

  it('updates the PTR record when a dynamic lease hostname changes', () => {
    syncDhcpDnsRecords(db, [{
      ip: '10.0.1.52',
      mac: 'aa:bb:cc:dd:ee:52',
      hostname: 'old-host',
      subnetId
    }]);

    syncDhcpDnsRecords(db, [{
      ip: '10.0.1.52',
      mac: 'aa:bb:cc:dd:ee:52',
      hostname: 'new-host',
      subnetId
    }]);

    const records = db.prepare(`
      SELECT name, value, source
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.52'
      ORDER BY name
    `).all(zoneId);
    const ptr = db.prepare(`
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '52'
    `).get(reverseZoneId);

    expect(records).toEqual([{ name: 'new-host', value: '10.0.1.52', source: 'dhcp' }]);
    expect(ptr.value).toBe('new-host.example.test');
  });

  it('keeps dynamic DNS and PTR during the one-hour offline retention window', () => {
    syncDhcpDnsRecords(db, [{
      ip: '10.0.1.53',
      mac: 'aa:bb:cc:dd:ee:53',
      hostname: 'lease-host',
      subnetId
    }]);

    syncDhcpDnsRecords(db, []);

    const record = db.prepare(`
      SELECT id FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.53'
    `).get(zoneId);
    const ptr = db.prepare(`
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '53'
    `).get(reverseZoneId);

    expect(record).toBeTruthy();
    expect(ptr.value).toBe('lease-host.example.test');
  });
});
