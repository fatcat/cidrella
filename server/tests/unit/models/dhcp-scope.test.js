import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DhcpScope from '../../../src/models/dhcp-scope.js';

let db;
let tmpDir;

function createSubnet() {
  return db
    .prepare(
      `
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, status, domain_name
    )
    VALUES ('10.50.0.0/24', 'scope-test', '10.50.0.0', '10.50.0.255', 24, 256, '10.50.0.1', 'allocated', 'scope.test')
  `,
    )
    .run().lastInsertRowid;
}

function createRange(subnetId, startIp = '10.50.0.50', endIp = '10.50.0.150') {
  const rangeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
  return db
    .prepare(
      `
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(subnetId, rangeType.id, startIp, endIp).lastInsertRowid;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM dhcp_scope_options').run();
  db.prepare('DELETE FROM dhcp_scopes').run();
  db.prepare('DELETE FROM ranges').run();
  db.prepare('DELETE FROM subnets').run();
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
});

describe('DHCP scope ownership', () => {
  it('rejects a pool over CIDRella when an enabled DNS record owns its address', () => {
    const subnetId = createSubnet();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const zoneId = db
      .prepare(
        `
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('scope.test', 'forward', 1)
    `,
      )
      .run().lastInsertRowid;
    db.prepare(
      `
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'cidrella', 'A', '10.50.0.75', 'manual', 1)
    `,
    ).run(zoneId);

    expect(DhcpScope.dynamicPoolConflict(db, subnet, '10.50.0.50', '10.50.0.150')).toMatchObject({
      type: 'static_dns',
      ip_address: '10.50.0.75',
    });
  });

  it('creates scopes and skips option values inherited from the subnet', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);

    const scope = DhcpScope.createScope(
      db,
      {
        range_id: rangeId,
        subnet_id: subnetId,
        options: [
          { code: 3, value: '10.50.0.1' },
          { code: 6, value: '10.50.0.8' },
        ],
      },
      { subnet, defaultLeaseTime: '24h' },
    );

    expect(scope.lease_time).toBe('24h');
    expect(scope.options).toEqual([{ option_code: 6, value: '10.50.0.8' }]);
    const router = scope.effective.options.find((option) => option.option_code === 3);
    expect(router).toEqual({ option_code: 3, value: '10.50.0.1', source: 'network' });
  });

  it('uses network topology for router, mask, and broadcast despite conflicting defaults', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    db.prepare(
      `
      UPDATE dhcp_option_defaults SET value = '10.99.99.1' WHERE option_code = 3
    `,
    ).run();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(
      db,
      {
        range_id: rangeId,
        subnet_id: subnetId,
        options: [{ code: 3, value: '10.88.88.1' }],
      },
      { subnet, defaultLeaseTime: '24h' },
    );
    const effective = Object.fromEntries(
      scope.effective.options.map((option) => [option.option_code, option]),
    );
    expect(effective[1]).toMatchObject({ value: '255.255.255.0', source: 'network' });
    expect(effective[3]).toMatchObject({ value: '10.50.0.1', source: 'network' });
    expect(effective[28]).toMatchObject({ value: '10.50.0.255', source: 'network' });
  });

  it('updates scope fields, range bounds, and replaces explicit options', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(
      db,
      {
        range_id: rangeId,
        subnet_id: subnetId,
        options: [{ code: 6, value: '10.50.0.8' }],
      },
      { subnet, defaultLeaseTime: '24h' },
    );

    const updated = DhcpScope.updateScope(
      db,
      scope,
      {
        lease_time: '12h',
        start_ip: '10.50.0.60',
        end_ip: '10.50.0.140',
        options: [{ code: 15, value: 'custom.scope.test' }],
      },
      { subnet },
    );

    expect(updated.lease_time).toBe('12h');
    expect(updated.start_ip).toBe('10.50.0.60');
    expect(updated.end_ip).toBe('10.50.0.140');
    expect(updated.options).toEqual([{ option_code: 15, value: 'custom.scope.test' }]);
  });

  it('deletes a scope, its explicit options, and its backing range', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(
      db,
      {
        range_id: rangeId,
        subnet_id: subnetId,
        options: [{ code: 6, value: '10.50.0.8' }],
      },
      { subnet, defaultLeaseTime: '24h' },
    );

    DhcpScope.deleteScope(db, scope);

    expect(db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(scope.id)).toBeUndefined();
    expect(
      db.prepare('SELECT * FROM dhcp_scope_options WHERE scope_id = ?').get(scope.id),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM ranges WHERE id = ?').get(rangeId)).toBeUndefined();
  });

  it('joins a legacy NTP list instead of passing JSON through', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const scopeId = db
      .prepare(
        `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, ntp_servers)
         VALUES (?, ?, '24h', '["10.50.0.9","10.50.0.10"]')`,
      )
      .run(rangeId, subnetId).lastInsertRowid;
    const scope = db
      .prepare(
        `SELECT s.*, sub.cidr AS subnet_cidr, sub.gateway_address AS subnet_gateway,
           sub.domain_name AS subnet_domain_name
         FROM dhcp_scopes s JOIN subnets sub ON sub.id = s.subnet_id WHERE s.id = ?`,
      )
      .get(scopeId);
    const ntp = DhcpScope.resolveEffectiveScopeOptions(db, scope).options.find(
      (option) => option.option_code === 42,
    );
    expect(ntp).toEqual({ option_code: 42, value: '10.50.0.9,10.50.0.10', source: 'legacy_scope' });
  });
});

describe('DHCPv6 scope options', () => {
  function createV6Subnet(domain = 'six.test') {
    return db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, last_address, prefix_length,
           address_family, status, domain_name)
         VALUES ('fd00:50::/64', 'v6-scope-test', 'fd00:50::', 'fd00:50::ffff:ffff:ffff:ffff', 64,
           6, 'allocated', ?)`,
      )
      .run(domain).lastInsertRowid;
  }

  function loadScope(scopeId) {
    return db
      .prepare(
        `SELECT s.*, sub.cidr AS subnet_cidr, sub.gateway_address AS subnet_gateway,
           sub.domain_name AS subnet_domain_name
         FROM dhcp_scopes s JOIN subnets sub ON sub.id = s.subnet_id WHERE s.id = ?`,
      )
      .get(scopeId);
  }

  it('creates an IPv6 scope whose option rows carry the family and skip inherited values', () => {
    const subnetId = createV6Subnet();
    const rangeId = createRange(subnetId, 'fd00:50::1000', 'fd00:50::1fff');
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(
      db,
      {
        range_id: rangeId,
        subnet_id: subnetId,
        v6_mode: 'stateful',
        options: [
          { code: 24, value: 'six.test' },
          { code: 23, value: 'fd00:50::53' },
          { code: 51, value: '3600' },
        ],
      },
      { subnet, defaultLeaseTime: '24h' },
    );
    expect(scope.address_family).toBe(6);
    // 24 equals the network domain so it is inherited, not stored; 51 is an
    // ordinary IPv6 code, not the IPv4 lease-time option.
    expect(
      db
        .prepare(
          'SELECT option_code, value, address_family FROM dhcp_scope_options WHERE scope_id = ? ORDER BY option_code',
        )
        .all(scope.id),
    ).toEqual([
      { option_code: 23, value: 'fd00:50::53', address_family: 6 },
      { option_code: 51, value: '3600', address_family: 6 },
    ]);
    const effective = Object.fromEntries(
      scope.effective.options.map((option) => [option.option_code, option]),
    );
    expect(effective[23]).toMatchObject({ value: 'fd00:50::53', source: 'scope' });
    expect(effective[24]).toMatchObject({ value: 'six.test', source: 'network' });
    expect(effective[1]).toBeUndefined();
    expect(effective[3]).toBeUndefined();
    expect(scope.effective.router_suppressed).toBe(false);
  });

  it('layers global IPv6 defaults, the scope columns and explicit rows in that order', () => {
    const subnetId = createV6Subnet();
    const rangeId = createRange(subnetId, 'fd00:50::1000', 'fd00:50::1fff');
    // Startup seeded 23 and 24 for IPv6; replace the rows this test pins.
    db.prepare(
      'DELETE FROM dhcp_option_defaults WHERE option_code IN (23, 32, 56) AND address_family IN (4, 6)',
    ).run();
    db.prepare(
      `INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, address_family)
       VALUES (56, 'fd00::123', 1, 6), (32, '7200', 1, 6), (23, 'fd00::1', 1, 6)`,
    ).run();
    // An IPv4 default with the same code must not leak into an IPv6 scope.
    db.prepare(
      `INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, address_family)
       VALUES (23, '99', 1, 4)`,
    ).run();
    const scopeId = db
      .prepare(
        `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode,
           dns_servers, ntp_servers, domain_search)
         VALUES (?, ?, '1h', 6, 'stateful', '["fd00:50::53","fd00:50::54"]', '["fd00:50::7"]', 'a.test,b.test')`,
      )
      .run(rangeId, subnetId).lastInsertRowid;
    db.prepare(
      'INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, 24, ?, 6)',
    ).run(scopeId, 'explicit.test');

    const effective = Object.fromEntries(
      DhcpScope.resolveEffectiveScopeOptions(db, loadScope(scopeId)).options.map((option) => [
        option.option_code,
        option,
      ]),
    );
    expect(effective[23]).toEqual({
      option_code: 23,
      value: 'fd00:50::53,fd00:50::54',
      source: 'legacy_scope',
    });
    expect(effective[56]).toEqual({ option_code: 56, value: 'fd00:50::7', source: 'legacy_scope' });
    expect(effective[24]).toEqual({ option_code: 24, value: 'explicit.test', source: 'scope' });
    expect(effective[32]).toEqual({ option_code: 32, value: '7200', source: 'global_default' });
    db.prepare('DELETE FROM dhcp_option_defaults WHERE option_code IN (23, 32, 56)').run();
  });
});
