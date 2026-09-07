import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';
import * as DeviceFingerprint from '../../../src/models/device-fingerprint.js';
import { buildIpAggregate, enrichIpViewRows } from '../../../src/models/ip-view.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  subnetId = db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status)
    VALUES ('10.88.0.0/24', 'Aggregate', '10.88.0.0', '10.88.0.255',
            24, 256, 'allocated')
  `).run().lastInsertRowid;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('canonical IP aggregate schema', () => {
  it('installs canonical identity and allocation columns and indexes', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name));
    for (const name of [
      'allocation_state', 'allocation_source_type', 'allocation_source_id',
      'address_family', 'address_sort_key', 'interface_id', 'preferred_until',
      'valid_until', 'dhcp_version'
    ]) {
      expect(columns, name).toContain(name);
    }

    const indexes = new Set(db.prepare('PRAGMA index_list(ip_addresses)').all().map(row => row.name));
    expect(indexes).toContain('idx_ip_addresses_allocation');
    expect(indexes).toContain('idx_ip_addresses_canonical_sort');
  });

  it('canonicalizes new IPv6 writes and records a numeric sort identity', () => {
    IpAddress.upsert(db, subnetId, '2001:0DB8:0:0:0:0:0:88', {
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      preferred_until: '2029-12-31T23:00:00.000Z',
      valid_until: '2030-01-01T00:00:00.000Z'
    });

    const row = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = '2001:db8::88'").get();
    expect(row).toMatchObject({
      address_family: 6,
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      interface_id: null
    });
    expect(row.address_sort_key).toHaveLength(33);
  });

  it('folds IPv4-mapped input onto the canonical IPv4 row', () => {
    const firstId = IpAddress.upsert(db, subnetId, '10.88.0.89', { hostname: 'mapped' });
    const secondId = IpAddress.upsert(db, subnetId, '::ffff:10.88.0.89', { is_online: 1 });

    expect(secondId).toBe(firstId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM ip_addresses WHERE ip_address = '10.88.0.89'").get().count)
      .toBe(1);
  });

  it('requires and separates IPv6 link-local interface context', () => {
    expect(() => IpAddress.upsert(db, subnetId, 'fe80::88', {}))
      .toThrow(/require interface context/);

    const eth0Id = IpAddress.upsert(db, subnetId, 'fe80::88%eth0', { hostname: 'eth0-host' });
    const eth1Id = IpAddress.upsert(db, subnetId, 'fe80::88%eth1', { hostname: 'eth1-host' });
    expect(eth1Id).not.toBe(eth0Id);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, 'fe80::88%eth0'))
      .toMatchObject({ id: eth0Id, ip_address: 'fe80::88', interface_id: 'eth0' });
    expect(IpAddress.findBySubnetAndIp(db, subnetId, 'fe80::88%eth1'))
      .toMatchObject({ id: eth1Id, ip_address: 'fe80::88', interface_id: 'eth1' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ip_addresses WHERE ip_address = 'fe80::88'").get().count)
      .toBe(2);

    const rows = enrichIpViewRows(db, [
      { subnet_id: subnetId, ip_address: 'fe80::88', interface_id: 'eth0' },
      { subnet_id: subnetId, ip_address: 'fe80::88', interface_id: 'eth1' }
    ], { fillFromIpAddress: true });
    expect(rows.map(row => row.hostname)).toEqual(['eth0-host', 'eth1-host']);
  });
});

describe('canonical IP read aggregate', () => {
  it('projects displayable DHCP fingerprint evidence with the device summary', () => {
    DeviceFingerprint.upsertFingerprint(db, {
      mac_address: 'aa:bb:cc:dd:ee:20',
      dhcp_fingerprint: '1,3,6,15',
      vendor_class: 'MSFT 5.0',
      dhcp_hostname: 'DESKTOP-AGGREGATE',
      device_type: 'Computer',
      os_family: 'Windows',
      confidence: 85,
      source: 'dhcp'
    });

    const [row] = enrichIpViewRows(db, [{
      subnet_id: subnetId,
      ip_address: '10.88.0.19',
      mac_address: 'AA:BB:CC:DD:EE:20'
    }]);
    expect(row).toMatchObject({
      device_type: 'Computer',
      os_family: 'Windows',
      device_confidence: 85,
      dhcp_fingerprint: '1,3,6,15',
      dhcp_vendor_class: 'MSFT 5.0',
      dhcp_fingerprint_hostname: 'DESKTOP-AGGREGATE',
      device_fingerprint_source: 'dhcp'
    });
  });

  it('projects the effective scanning toggle from IP, subnet, then global settings', () => {
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'default_scan_enabled'").run();
    const inherited = enrichIpViewRows(db, [{ subnet_id: subnetId, ip_address: '10.88.0.20' }]);
    expect(inherited[0].scanning_enabled).toBe(true);

    db.prepare('UPDATE subnets SET scan_enabled = 0 WHERE id = ?').run(subnetId);
    const subnetDisabled = enrichIpViewRows(db, [{ subnet_id: subnetId, ip_address: '10.88.0.21' }]);
    expect(subnetDisabled[0].scanning_enabled).toBe(false);

    const ipEnabled = enrichIpViewRows(db, [{
      subnet_id: subnetId, ip_address: '10.88.0.22', scan_enabled: 1
    }]);
    expect(ipEnabled[0].scanning_enabled).toBe(true);
  });

  it('projects custom Network Range Type metadata without changing allocation', () => {
    const rangeTypeId = db.prepare(`
      INSERT INTO range_types (name, color, is_system, description)
      VALUES ('Printers', '#22c55e', 0, 'Organizational tag only')
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, '10.88.0.40', '10.88.0.49')
    `).run(subnetId, rangeTypeId);

    const [tagged, untagged] = enrichIpViewRows(db, [
      { subnet_id: subnetId, ip_address: '10.88.0.44', allocation_state: 'unassigned' },
      { subnet_id: subnetId, ip_address: '10.88.0.50', allocation_state: 'unassigned' }
    ]);

    expect(tagged).toMatchObject({
      allocation_state: 'unassigned',
      network_range_type_id: Number(rangeTypeId),
      network_range_type: 'Printers',
      network_range_type_color: '#22c55e'
    });
    expect(untagged).toMatchObject({
      allocation_state: 'unassigned',
      network_range_type_id: null,
      network_range_type: null,
      network_range_type_color: null
    });
  });

  it('adds canonical identity without inferring allocation from protocol shape', () => {
    expect(buildIpAggregate({
      ip_address: '2001:0DB8:0:0:0:0:0:90',
      has_static_dns: 1,
      allocation_state: 'unassigned'
    })).toMatchObject({
      ip_address: '2001:db8::90',
      address_family: 6,
      address_type: null,
      allocation_state: 'unassigned'
    });
  });

  it('projects allocation, SLAAC, pool, and conflict states without changing liveness', () => {
    expect(buildIpAggregate({ allocation_state: 'slaac', is_online: 0 })).toMatchObject({
      allocation_state: 'slaac',
      address_type: 'SLAAC',
      ip_display_status: 'in use',
      is_online: 0
    });
    expect(buildIpAggregate({ allocation_state: 'unassigned', in_dynamic_pool: 1 })).toMatchObject({
      address_type: null,
      ip_display_status: 'DHCP Scope'
    });
    expect(buildIpAggregate({
      allocation_state: 'static_dns',
      is_rogue: 1,
      rogue_reason: 'MAC mismatch'
    })).toMatchObject({
      address_type: 'static DNS',
      address_conflict: true,
      address_conflict_reason: 'MAC mismatch'
    });
  });
});
