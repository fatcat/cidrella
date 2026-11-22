import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';

vi.mock('../../../src/utils/after-commit.js', () => ({
  queueRegen: vi.fn(),
  registerHookHandlers: vi.fn(),
}));

let db;
let tmpDir;
let subnetId;
let scopeId;
let zoneId;
let reverseZoneId;
let syncDhcpDnsRecords;
let replaceLeases;
// The offline window (OFFLINE_RETIREMENT_MS), loaded after the test database.
let WINDOW;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  ({ syncDhcpDnsRecords, replaceLeases } = await import('../../../src/models/dhcp-lease.js'));
  ({ OFFLINE_RETIREMENT_MS: WINDOW } =
    await import('../../../src/services/ip-lifecycle-service.js'));

  db.prepare(
    `
    INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status, domain_name)
    VALUES ('10.0.1.0/24', 'DHCP DNS', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated', 'example.test')
  `,
  ).run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.1.0/24'").get().id;

  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const range = db
    .prepare(
      `
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, '10.0.1.20', '10.0.1.200')
  `,
    )
    .run(subnetId, rangeTypeId);

  const scope = db
    .prepare(
      `
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time)
    VALUES (?, ?, '24h')
  `,
    )
    .run(range.lastInsertRowid, subnetId);
  scopeId = scope.lastInsertRowid;
  db.prepare(
    `
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
    VALUES (?, ?, '10.0.1.20', '10.0.1.200')
  `,
  ).run(scopeId, range.lastInsertRowid);

  const zone = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)")
    .run();
  zoneId = zone.lastInsertRowid;
  reverseZoneId = db
    .prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('1.0.10.in-addr.arpa', 'reverse', 1)",
    )
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
      subnetId,
    };
    replaceLeases(db, [lease]);

    replaceLeases(db, []);

    const retained = db
      .prepare(
        `
      SELECT *, datetime(expires_at) <= datetime('now') AS expired
      FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?
    `,
      )
      .get(subnetId, lease.ip);
    expect(retained).toMatchObject({
      mac_address: lease.mac,
      hostname: lease.hostname,
      client_id: lease.clientId,
      expired: 1,
    });
    expect(
      db
        .prepare('SELECT allocation_state FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
        .get(subnetId, lease.ip).allocation_state,
    ).toBe('unassigned');
  });
});

describe('replaceLeases, a lease the backend dropped', () => {
  let subnet6Id;
  beforeAll(() => {
    enableIpv6(db);
    subnet6Id = db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
           total_addresses, status, address_family)
         VALUES ('fd00:1::/64', 'v6', 'fd00:1::', NULL, 64, '18446744073709551616', 'allocated', 6)`,
      )
      .run().lastInsertRowid;
    const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const range6 = db
      .prepare(
        `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
         VALUES (?, ?, 'fd00:1::10', 'fd00:1::ff')`,
      )
      .run(subnet6Id, rangeTypeId).lastInsertRowid;
    const scope6 = db
      .prepare(
        `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode)
         VALUES (?, ?, '24h', 6, 'stateful')`,
      )
      .run(range6, subnet6Id).lastInsertRowid;
    db.prepare(
      `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
       VALUES (?, ?, 'fd00:1::10', 'fd00:1::ff')`,
    ).run(scope6, range6);
  });

  const kept = (ip) => db.prepare('SELECT * FROM dhcp_leases WHERE ip_address = ?').get(ip);

  it.each([
    ['10.0.1.70', { mac: 'aa:bb:cc:00:00:70', dhcpVersion: 4 }],
    ['fd00:1::70', { duid: '00:01:00:01:aa:bb:cc:00:00:70', iaid: 1, dhcpVersion: 6 }],
  ])('keeps %s for the offline window after it expired, then lets it go', (ip, client) => {
    const subnet = ip.includes(':') ? subnet6Id : subnetId;
    const now = Date.now();
    const lease = {
      ip,
      hostname: 'gone',
      clientId: null,
      expiresAt: new Date(now - 10 * 60_000).toISOString(),
      subnetId: subnet,
      ...client,
    };
    replaceLeases(db, [lease], { now });
    replaceLeases(db, [], { now });
    expect(kept(ip)).toMatchObject({ hostname: 'gone' });
    replaceLeases(db, [], { now: now + WINDOW / 2 });
    expect(kept(ip)).toBeTruthy();
    replaceLeases(db, [], { now: now + WINDOW });
    expect(kept(ip)).toBeUndefined();
  });

  it('starts the window when a lease still running is dropped', () => {
    const now = Date.now();
    replaceLeases(db, [
      { ip: '10.0.1.71', mac: 'aa:bb:cc:00:00:71', hostname: 'h', expiresAt: 'infinite', subnetId },
    ]);
    replaceLeases(db, [], { now });
    replaceLeases(db, [], { now: now + WINDOW - 10 * 60_000 });
    expect(kept('10.0.1.71')).toBeTruthy();
    replaceLeases(db, [], { now: now + WINDOW + 60_000 });
    expect(kept('10.0.1.71')).toBeUndefined();
  });
});

describe('lease history', () => {
  const obtained = (ip) =>
    db
      .prepare(
        "SELECT count(*) n FROM ip_events WHERE ip_address = ? AND event_type = 'lease_obtained'",
      )
      .get(ip).n;
  const lease = (ip, mac, expiresAt) => ({
    ip,
    mac,
    hostname: 'renewer',
    clientId: null,
    expiresAt,
    subnetId,
  });
  const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

  it('records one lease_obtained per lease, not one per renewal', () => {
    replaceLeases(db, [lease('10.0.1.60', 'aa:bb:cc:00:00:60', inHours(1))]);
    replaceLeases(db, [lease('10.0.1.60', 'aa:bb:cc:00:00:60', inHours(2))]);
    replaceLeases(db, [lease('10.0.1.60', 'aa:bb:cc:00:00:60', inHours(3))]);
    expect(obtained('10.0.1.60')).toBe(1);
    // Another client on the address is a new lease.
    replaceLeases(db, [lease('10.0.1.60', 'aa:bb:cc:00:00:61', inHours(4))]);
    expect(obtained('10.0.1.60')).toBe(2);
  });

  it('records a DHCP Reservation lease once, however often the sync runs', () => {
    db.prepare(
      `INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
       VALUES (?, '10.0.1.61', 'aa:bb:cc:00:00:62', 'reserved-host', 1)`,
    ).run(subnetId);
    for (let i = 0; i < 5; i++) {
      replaceLeases(db, [lease('10.0.1.61', 'aa:bb:cc:00:00:62', 'infinite')]);
    }
    expect(obtained('10.0.1.61')).toBe(1);
  });

  const rows = () =>
    db
      .prepare(
        'SELECT id, ip_address, expires_at, last_seen FROM dhcp_leases WHERE subnet_id = ? ORDER BY id',
      )
      .all(subnetId);
  const backdate = () =>
    db.prepare("UPDATE dhcp_leases SET last_seen = '2000-01-01 00:00:00'").run();

  it('keeps a lease in its row across syncs and leaves an unchanged one unwritten', () => {
    const expiry = inHours(1);
    replaceLeases(db, [lease('10.0.1.63', 'aa:bb:cc:00:00:64', expiry)]);
    const [first] = rows();
    backdate();
    replaceLeases(db, [lease('10.0.1.63', 'aa:bb:cc:00:00:64', expiry)]);
    // Same id, and the row was not written: its stamp is still the old one.
    expect(rows()).toEqual([{ ...first, last_seen: '2000-01-01 00:00:00' }]);

    // A renewal changes the same row.
    const renewed = inHours(2);
    replaceLeases(db, [lease('10.0.1.63', 'aa:bb:cc:00:00:64', renewed)]);
    const [after] = rows();
    expect(after.id).toBe(first.id);
    expect(after.expires_at).toBe(renewed);
    expect(after.last_seen).not.toBe('2000-01-01 00:00:00');
  });

  it('keeps a DHCPv6 lease in its row too, and changes only the lease that changed', () => {
    enableIpv6(db);
    const v6 = (expiresAt) => ({
      ip: '2001:db8:63::10',
      mac: null,
      hostname: 'six',
      clientId: null,
      expiresAt,
      subnetId: null,
      dhcpVersion: 6,
      duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
      iaid: 7,
    });
    const v6Row = () =>
      db
        .prepare(
          "SELECT id, expires_at, last_seen FROM dhcp_leases WHERE ip_address = '2001:db8:63::10'",
        )
        .get();
    const expiry = inHours(1);
    replaceLeases(db, [v6(expiry), lease('10.0.1.64', 'aa:bb:cc:00:00:65', expiry)]);
    const first = v6Row();
    backdate();
    replaceLeases(db, [v6(expiry), lease('10.0.1.64', 'aa:bb:cc:00:00:65', inHours(2))]);
    expect(v6Row()).toEqual({ ...first, last_seen: '2000-01-01 00:00:00' });
    expect(rows()[0].last_seen).not.toBe('2000-01-01 00:00:00');
    replaceLeases(db, [v6(inHours(3))]);
    expect(v6Row().id).toBe(first.id);
    db.prepare("DELETE FROM dhcp_leases WHERE ip_address = '2001:db8:63::10'").run();
  });

  it('leaves one row for an address that had two', () => {
    const expiry = inHours(1);
    replaceLeases(db, [lease('10.0.1.65', 'aa:bb:cc:00:00:66', expiry)]);
    db.prepare(
      `INSERT INTO dhcp_leases (ip_address, mac_address, hostname, expires_at, subnet_id, last_seen)
       SELECT ip_address, mac_address, hostname, expires_at, subnet_id, last_seen FROM dhcp_leases
       WHERE ip_address = '10.0.1.65'`,
    ).run();
    expect(rows()).toHaveLength(2);
    replaceLeases(db, [lease('10.0.1.65', 'aa:bb:cc:00:00:66', expiry)]);
    expect(rows()).toHaveLength(1);
  });

  it('records a lease again when the client comes back after it expired', () => {
    replaceLeases(db, [lease('10.0.1.62', 'aa:bb:cc:00:00:63', inHours(1))]);
    db.prepare(
      "UPDATE dhcp_leases SET expires_at = datetime('now', '-1 hour') WHERE ip_address = '10.0.1.62'",
    ).run();
    replaceLeases(db, [lease('10.0.1.62', 'aa:bb:cc:00:00:63', inHours(2))]);
    expect(obtained('10.0.1.62')).toBe(2);
  });
});

describe('syncDhcpDnsRecords', () => {
  it('stamps a record its lease still answers once an hour, not on every sync', () => {
    const leases = [{ ip: '10.0.1.70', hostname: 'stamped', subnetId }];
    syncDhcpDnsRecords(db, leases);
    const stamp = () =>
      db.prepare("SELECT updated_at FROM dns_records WHERE name = 'stamped'").get().updated_at;
    const set = (when) =>
      db.prepare("UPDATE dns_records SET updated_at = ? WHERE name = 'stamped'").run(when);
    const minutesAgo = (m) => db.prepare("SELECT datetime('now', ?) t").get(`-${m} minutes`).t;

    const recent = minutesAgo(10);
    set(recent);
    syncDhcpDnsRecords(db, leases);
    expect(stamp()).toBe(recent);

    set(minutesAgo(90));
    syncDhcpDnsRecords(db, leases);
    expect(stamp() > minutesAgo(5)).toBe(true);
  });

  it('creates DHCP-sourced A records for dynamic leases with hostnames', () => {
    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.50',
        mac: 'aa:bb:cc:dd:ee:50',
        hostname: 'lease-host',
        subnetId,
      },
    ]);

    const row = db
      .prepare(
        `
      SELECT name, type, value, source, enabled
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.50'
    `,
      )
      .get(zoneId);

    expect(row).toEqual({
      name: 'lease-host',
      type: 'A',
      value: '10.0.1.50',
      source: 'dhcp',
      enabled: 1,
    });

    const ptr = db
      .prepare(
        `
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '50'
    `,
      )
      .get(reverseZoneId);

    expect(ptr).toEqual({ value: 'lease-host.example.test', source: 'dhcp' });
  });

  it('keeps reservation hostname over dynamic lease hostname for the same IP', () => {
    db.prepare(
      `
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.0.1.51', 'aa:bb:cc:dd:ee:51', 'reserved-host', 1)
    `,
    ).run(subnetId);

    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.51',
        mac: 'aa:bb:cc:dd:ee:51',
        hostname: 'lease-host',
        subnetId,
      },
    ]);

    const row = db
      .prepare(
        `
      SELECT name, value, source
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.51'
    `,
      )
      .get(zoneId);

    expect(row).toEqual({
      name: 'reserved-host',
      value: '10.0.1.51',
      source: 'reservation',
    });

    const ptr = db
      .prepare(
        `
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '51'
    `,
      )
      .get(reverseZoneId);

    expect(ptr).toEqual({ value: 'reserved-host.example.test', source: 'reservation' });
  });

  it('updates the PTR record when a dynamic lease hostname changes', () => {
    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.52',
        mac: 'aa:bb:cc:dd:ee:52',
        hostname: 'old-host',
        subnetId,
      },
    ]);

    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.52',
        mac: 'aa:bb:cc:dd:ee:52',
        hostname: 'new-host',
        subnetId,
      },
    ]);

    const records = db
      .prepare(
        `
      SELECT name, value, source
      FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.52'
      ORDER BY name
    `,
      )
      .all(zoneId);
    const ptr = db
      .prepare(
        `
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '52'
    `,
      )
      .get(reverseZoneId);

    expect(records).toEqual([{ name: 'new-host', value: '10.0.1.52', source: 'dhcp' }]);
    expect(ptr.value).toBe('new-host.example.test');
  });

  it('keeps dynamic DNS and PTR during the one-hour offline retention window', () => {
    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.53',
        mac: 'aa:bb:cc:dd:ee:53',
        hostname: 'lease-host',
        subnetId,
      },
    ]);

    syncDhcpDnsRecords(db, []);

    const record = db
      .prepare(
        `
      SELECT id FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.53'
    `,
      )
      .get(zoneId);
    const ptr = db
      .prepare(
        `
      SELECT value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '53'
    `,
      )
      .get(reverseZoneId);

    expect(record).toBeTruthy();
    expect(ptr.value).toBe('lease-host.example.test');
  });

  it('uses the effective domain of the scope containing each lease', () => {
    db.prepare("UPDATE dhcp_scope_pools SET end_ip = '10.0.1.80' WHERE scope_id = ?").run(scopeId);
    const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const rangeId = db
      .prepare(
        `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, '10.0.1.100', '10.0.1.150')
    `,
      )
      .run(subnetId, typeId).lastInsertRowid;
    const secondScope = db
      .prepare(
        `
      INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time) VALUES (?, ?, '24h')
    `,
      )
      .run(rangeId, subnetId).lastInsertRowid;
    db.prepare(
      `
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
      VALUES (?, ?, '10.0.1.100', '10.0.1.150')
    `,
    ).run(secondScope, rangeId);
    db.prepare(
      `
      INSERT INTO dhcp_scope_options (scope_id, option_code, value)
      VALUES (?, 15, 'scope-specific.test')
    `,
    ).run(secondScope);
    const specificZone = db
      .prepare(
        `
      INSERT INTO dns_zones (name, type, enabled) VALUES ('scope-specific.test', 'forward', 1)
    `,
      )
      .run().lastInsertRowid;

    syncDhcpDnsRecords(db, [
      {
        ip: '10.0.1.120',
        mac: 'aa:bb:cc:dd:01:20',
        hostname: 'scoped',
        subnetId,
      },
    ]);

    expect(
      db
        .prepare(
          `
      SELECT name, value FROM dns_records WHERE zone_id = ? AND type = 'A'
    `,
        )
        .get(specificZone),
    ).toEqual({ name: 'scoped', value: '10.0.1.120' });
    expect(
      db
        .prepare(
          `
      SELECT id FROM dns_records WHERE zone_id = ? AND type = 'A' AND value = '10.0.1.120'
    `,
        )
        .get(zoneId),
    ).toBeUndefined();
  });
});
