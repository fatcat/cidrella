import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { getDb, initDb } from '../../../src/db/init.js';
import {
  allocateStaticDns,
  allocateStaticDhcp,
  deallocateStaticDhcp,
  dhcpLeaseRejectionReason,
  observeDhcpLeases,
  observeDhcpv6Lease,
  observeNeighbor,
  observeRouterAdvertisement,
  observeScanResult,
  observeSlaac,
  retireStaleDynamicAddresses,
  setManualReservation
} from '../../../src/services/ip-lifecycle-service.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  subnetId = db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status, domain_name)
    VALUES ('10.99.0.0/24', 'Lifecycle service', '10.99.0.0', '10.99.0.255',
            24, 256, 'allocated', 'service.test')
  `).run().lastInsertRowid;
});

beforeEach(() => {
  db.prepare('DELETE FROM dhcp_scope_options').run();
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
});

afterAll(() => cleanupTestDb(tmpDir));

function address(ip) {
  return db.prepare('SELECT * FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
    .get(subnetId, ip);
}

function createDynamicScope(start = '10.99.0.20', end = '10.99.0.30') {
  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'")
    .get().id;
  const rangeId = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(subnetId, rangeTypeId, start, end).lastInsertRowid;
  db.prepare(`
    INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time, enabled)
    VALUES (?, ?, '24h', 1)
  `).run(subnetId, rangeId);
}

describe('IP lifecycle service allocation boundary', () => {
  it('owns administrative reserve and release transitions', () => {
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, status, is_rogue, rogue_reason, allocation_state)
      VALUES (?, '10.99.0.20', 'available', 1, 'observed conflict', 'unassigned')
    `).run(subnetId);
    setManualReservation(db, subnetId, '10.99.0.20', true, 'printer hold');
    expect(address('10.99.0.20')).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'admin_reservation',
      status: 'locked',
      reservation_note: 'printer hold',
      is_rogue: 0,
      rogue_reason: null
    });

    setManualReservation(db, subnetId, '10.99.0.20', false);
    expect(address('10.99.0.20')).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      status: 'available'
    });
  });

  it('owns static DNS allocation state', () => {
    const zoneId = db.prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('service.test', 'forward', 1)"
    ).run().lastInsertRowid;
    const recordId = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'nas', 'A', '10.99.0.21', 'manual', 1)
    `).run(zoneId).lastInsertRowid;

    allocateStaticDns(db, 'nas', '10.99.0.21', 'service.test', recordId);
    expect(address('10.99.0.21')).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_type: 'dns',
      allocation_source_id: recordId,
      hostname: 'nas.service.test'
    });
  });

  it('owns static DHCP allocation and release', () => {
    const reservationId = db.prepare(`
      INSERT INTO dhcp_reservations
        (subnet_id, mac_address, ip_address, hostname, enabled)
      VALUES (?, 'aa:bb:cc:dd:ee:22', '10.99.0.22', 'printer', 1)
    `).run(subnetId).lastInsertRowid;

    allocateStaticDhcp(db, subnetId, '10.99.0.22', {
      hostname: 'printer',
      mac_address: 'aa:bb:cc:dd:ee:22'
    }, reservationId);
    expect(address('10.99.0.22')).toMatchObject({
      allocation_state: 'static_dhcp',
      allocation_source_type: 'dhcp_reservation',
      allocation_source_id: reservationId,
      dhcp_version: 4
    });

    db.prepare('DELETE FROM dhcp_reservations WHERE id = ?').run(reservationId);
    deallocateStaticDhcp(db, subnetId, '10.99.0.22', 'aa:bb:cc:dd:ee:22');
    expect(address('10.99.0.22')).toBeUndefined();
  });

  it('releases dynamic allocation authority when a lease disappears', () => {
    createDynamicScope();
    const lease = {
      ip: '10.99.0.23',
      mac: 'aa:bb:cc:dd:ee:23',
      hostname: 'dynamic-host',
      clientId: null,
      expiresAt: 'infinite',
      subnetId,
      observedActivity: true
    };
    db.prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(subnetId, lease.ip, lease.mac, lease.hostname, lease.expiresAt);
    observeDhcpLeases(db, [lease]);
    expect(address(lease.ip)).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease',
      is_online: 1
    });

    db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?')
      .run(subnetId, lease.ip);
    observeDhcpLeases(db, []);
    expect(address(lease.ip)).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      allocation_source_id: null
    });
  });

  it('rejects dynamic leases outside pools and on reserved addresses', () => {
    createDynamicScope();
    expect(dhcpLeaseRejectionReason(db, {
      subnetId, ip: '10.99.0.40', mac: 'aa:bb:cc:dd:ee:40'
    })).toMatch(/outside an enabled DHCP scope/);

    setManualReservation(db, subnetId, '10.99.0.24', true, 'hold');
    expect(dhcpLeaseRejectionReason(db, {
      subnetId, ip: '10.99.0.24', mac: 'aa:bb:cc:dd:ee:24'
    })).toMatch(/reserved to dynamic_dhcp/);
  });
});

describe('one-hour continuous-offline retirement', () => {
  const baseTime = new Date('2031-05-20T12:00:00.000Z');

  function seedDynamic(ip = '10.99.0.23') {
    createDynamicScope();
    const lease = {
      ip,
      mac: 'aa:bb:cc:dd:ee:23',
      hostname: 'dynamic-host',
      clientId: 'client-23',
      expiresAt: 'infinite',
      subnetId,
      observedActivity: true
    };
    db.prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, client_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(subnetId, lease.ip, lease.mac, lease.hostname, lease.clientId, lease.expiresAt);
    observeDhcpLeases(db, [lease]);
    return lease;
  }

  function setOfflineAt(ip, timestamp) {
    db.prepare(`
      UPDATE ip_addresses
      SET is_online = 0, offline_since_at = ?, last_seen_at = ?
      WHERE subnet_id = ? AND ip_address = ?
    `).run(timestamp, timestamp, subnetId, ip);
  }

  function seedDynamicDns(ip) {
    const forwardZoneId = db.prepare(`
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('service.test', 'forward', 1)
    `).run().lastInsertRowid;
    const reverseZoneId = db.prepare(`
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('0.99.10.in-addr.arpa', 'reverse', 1)
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'dynamic-host', 'A', ?, 'dhcp', 1)
    `).run(forwardZoneId, ip);
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, enabled)
      VALUES (?, '23', 'PTR', 'dynamic-host.service.test', 1)
    `).run(reverseZoneId);
  }

  it('keeps dynamic observations at 59 minutes and retires them at 60 minutes', () => {
    const lease = seedDynamic();
    seedDynamicDns(lease.ip);
    db.prepare(`
      UPDATE ip_addresses SET description = 'operator note', scan_enabled = 0
      WHERE subnet_id = ? AND ip_address = ?
    `).run(subnetId, lease.ip);
    setOfflineAt(lease.ip, '2031-05-20T11:00:00.000Z');
    const releaseLease = vi.fn(() => ({ released: true }));

    const beforeBoundary = retireStaleDynamicAddresses(db, {
      now: new Date('2031-05-20T11:59:00.000Z'), releaseLease
    });
    expect(beforeBoundary.retired).toBe(0);
    expect(address(lease.ip)).toMatchObject({
      hostname: lease.hostname,
      mac_address: lease.mac,
      allocation_state: 'dynamic_dhcp'
    });
    expect(releaseLease).not.toHaveBeenCalled();

    const atBoundary = retireStaleDynamicAddresses(db, { now: baseTime, releaseLease });
    expect(atBoundary).toEqual({
      retired: 1,
      deferred: 0,
      dnsRecordsRemoved: 1,
      leasesRemoved: 1,
      stickyRelease: { released: 1, skipped: 0, failed: 0 }
    });
    expect(releaseLease).toHaveBeenCalledWith(expect.objectContaining({
      ip_address: lease.ip,
      mac_address: lease.mac,
      client_id: lease.clientId
    }));
    expect(address(lease.ip)).toMatchObject({
      hostname: null,
      mac_address: null,
      last_seen_at: null,
      offline_since_at: null,
      allocation_state: 'unassigned',
      description: 'operator note',
      scan_enabled: 0
    });
    expect(db.prepare('SELECT id FROM dhcp_leases WHERE ip_address = ?').get(lease.ip)).toBeUndefined();
    expect(db.prepare('SELECT id FROM dns_records WHERE value = ?').all(lease.ip)).toEqual([]);
    expect(db.prepare("SELECT id FROM dns_records WHERE type = 'PTR'").all()).toEqual([]);

    expect(retireStaleDynamicAddresses(db, { now: baseTime, releaseLease }).retired).toBe(0);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('cancels retirement when activity resumes before the boundary', () => {
    const lease = seedDynamic();
    setOfflineAt(lease.ip, '2031-05-20T11:00:00.000Z');

    observeScanResult(db, subnetId, lease.ip, {
      responded: 1,
      mac: lease.mac,
      isConflict: 0,
      conflictReason: null
    });
    expect(address(lease.ip).offline_since_at).toBeNull();

    expect(retireStaleDynamicAddresses(db, { now: baseTime, releaseLease: vi.fn() }).retired)
      .toBe(0);
    expect(address(lease.ip)).toMatchObject({ is_online: 1, allocation_state: 'dynamic_dhcp' });
  });

  it('uses the persisted offline edge across restarts and handles a future clock safely', async () => {
    const lease = seedDynamic();
    db.prepare(`
      UPDATE ip_addresses SET is_online = 0, offline_since_at = NULL
      WHERE subnet_id = ? AND ip_address = ?
    `).run(subnetId, lease.ip);

    expect(retireStaleDynamicAddresses(db, { now: baseTime, releaseLease: vi.fn() }).retired)
      .toBe(0);
    expect(address(lease.ip).offline_since_at).toBe('2031-05-20 12:00:00');

    db.close();
    await initDb(tmpDir);
    db = getDb();

    expect(retireStaleDynamicAddresses(db, {
      now: new Date('2031-05-20T12:59:00.000Z'), releaseLease: vi.fn()
    }).retired).toBe(0);

    // A backwards clock step leaves the persisted edge in the future and must
    // never turn into a negative elapsed interval or immediate retirement.
    expect(retireStaleDynamicAddresses(db, {
      now: new Date('2031-05-20T10:00:00.000Z'), releaseLease: vi.fn()
    }).retired).toBe(0);
    expect(retireStaleDynamicAddresses(db, {
      now: new Date('2031-05-20T13:00:00.000Z'),
      releaseLease: vi.fn(() => ({ released: true }))
    }).retired).toBe(1);
  });

  it('defers database cleanup when an active sticky lease cannot be released', () => {
    const lease = seedDynamic();
    setOfflineAt(lease.ip, '2031-05-20T11:00:00.000Z');

    const result = retireStaleDynamicAddresses(db, {
      now: baseTime,
      releaseLease: vi.fn(() => ({ released: false, error: 'network unavailable' }))
    });

    expect(result).toMatchObject({
      retired: 0,
      deferred: 1,
      leasesRemoved: 0,
      stickyRelease: { released: 0, skipped: 0, failed: 1 }
    });
    expect(address(lease.ip)).toMatchObject({
      hostname: lease.hostname,
      mac_address: lease.mac,
      allocation_state: 'dynamic_dhcp'
    });
    expect(db.prepare('SELECT id FROM dhcp_leases WHERE ip_address = ?').get(lease.ip)).toBeTruthy();
  });

  it('retires rogue and expired SLAAC observations but preserves live authority', () => {
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, status, is_online, is_rogue, rogue_reason,
         hostname, mac_address, detection_source, allocation_state,
         address_family, address_sort_key, offline_since_at)
      VALUES (?, '10.99.0.40', 'available', 0, 0, NULL,
              'rogue-host', 'aa:bb:cc:dd:ee:40', 'scanner', 'unassigned',
              4, '40000000000000000000000000a630028', '2031-05-20T11:00:00.000Z')
    `).run(subnetId);
    observeSlaac(db, subnetId, '2001:db8::41', {
      interfaceId: 'eth0',
      preferredUntil: '2031-05-20T10:00:00.000Z',
      validUntil: '2031-05-20T11:00:00.000Z'
    });
    setOfflineAt('2001:db8::41', '2031-05-20T11:00:00.000Z');
    observeSlaac(db, subnetId, '2001:db8::42', {
      interfaceId: 'eth0',
      preferredUntil: '2031-05-20T13:00:00.000Z',
      validUntil: '2031-05-20T14:00:00.000Z'
    });
    setOfflineAt('2001:db8::42', '2031-05-20T11:00:00.000Z');

    expect(retireStaleDynamicAddresses(db, { now: baseTime, releaseLease: vi.fn() }).retired)
      .toBe(2);
    expect(address('10.99.0.40')).toMatchObject({ hostname: null, allocation_state: 'unassigned' });
    expect(address('2001:db8::41')).toMatchObject({ valid_until: null, allocation_state: 'unassigned' });
    expect(address('2001:db8::42')).toMatchObject({
      valid_until: '2031-05-20T14:00:00.000Z',
      allocation_state: 'slaac'
    });
  });

  it('preserves observations for every administrative and protected state', () => {
    for (const [index, state] of [
      'static_dns', 'static_dhcp', 'reserved', 'system', 'gateway'
    ].entries()) {
      const ip = `10.99.0.${50 + index}`;
      db.prepare(`
        INSERT INTO ip_addresses
          (subnet_id, ip_address, hostname, mac_address, status, is_online,
           allocation_state, detection_source, offline_since_at)
        VALUES (?, ?, ?, ?, 'assigned', 0, ?, 'scanner', '2031-05-20T10:00:00.000Z')
      `).run(subnetId, ip, `${state}-host`, `aa:bb:cc:dd:ef:${50 + index}`, state);
    }

    expect(retireStaleDynamicAddresses(db, { now: baseTime, releaseLease: vi.fn() }).retired)
      .toBe(0);
    for (const state of ['static_dns', 'static_dhcp', 'reserved', 'system', 'gateway']) {
      expect(db.prepare('SELECT hostname, mac_address FROM ip_addresses WHERE hostname = ?')
        .get(`${state}-host`)).toBeTruthy();
    }
  });
});

describe('future IPv6 lifecycle adapters', () => {
  it('records DHCPv6 allocation without deriving gateway authority', () => {
    observeDhcpv6Lease(db, subnetId, '2001:db8::97', {
      duid: '00:04:11:22:33:44:55:66',
      iaid: '7',
      preferredUntil: '2029-12-31T23:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
      poolValidated: true,
      routerAddress: '2001:db8::1'
    });
    expect(address('2001:db8::97')).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease',
      dhcp_version: 6,
      is_online: 1
    });
    expect(() => observeDhcpv6Lease(db, subnetId, '2001:db8::96', {
      duid: '00:04:11:22:33:44:55:66',
      iaid: '8',
      validUntil: '2030-01-01T00:00:00.000Z'
    })).toThrow(/validated enabled-pool membership/);
  });

  it('records SLAAC lifetimes and interface context', () => {
    observeSlaac(db, subnetId, '2001:0DB8::99', {
      interfaceId: 'eth0',
      preferredUntil: '2029-12-31T23:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
      temporary: true
    });
    expect(address('2001:db8::99')).toMatchObject({
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      interface_id: 'eth0',
      detection_source: 'slaac_privacy'
    });
  });

  it('records Neighbor Discovery as liveness without changing allocation', () => {
    observeNeighbor(db, subnetId, 'fe80::99%eth0', { mac: 'aa:bb:cc:dd:ee:99' });
    expect(address('fe80::99')).toMatchObject({
      allocation_state: 'unassigned',
      interface_id: 'eth0',
      is_online: 1,
      is_rogue: 1,
      detection_source: 'neighbor_discovery'
    });

    setManualReservation(db, subnetId, 'fe80::98%eth0', true, 'IPv6 hold');
    observeNeighbor(db, subnetId, 'fe80::98%eth0', { mac: 'aa:bb:cc:dd:ee:98' });
    expect(address('fe80::98')).toMatchObject({
      allocation_state: 'reserved',
      is_online: 1,
      is_rogue: 0,
      rogue_reason: null
    });
  });

  it('accepts only trusted Router Advertisement gateway authority', () => {
    expect(() => observeRouterAdvertisement(db, subnetId, 'fe80::1%eth0'))
      .toThrow(/Untrusted Router Advertisement/);
    observeRouterAdvertisement(db, subnetId, 'fe80::1%eth0', { trusted: true });
    expect(address('fe80::1')).toMatchObject({
      allocation_state: 'gateway',
      allocation_source_type: 'topology',
      interface_id: 'eth0'
    });
  });
});
