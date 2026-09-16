import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import workspaceRouter from '../../../src/routes/workspace.js';
import dnsRouter from '../../../src/routes/dns.js';
import dhcpRouter from '../../../src/routes/dhcp.js';

let app;
let db;
let tmpDir;
let folderId;
let subnetA;
let subnetB;
let zoneId;
let scopeId;

function addSubnet(cidr, name, network, broadcast, domainName, folder) {
  return Number(
    db
      .prepare(
        `
          INSERT INTO subnets
            (cidr, name, network_address, broadcast_address, prefix_length,
             total_addresses, status, depth, domain_name, folder_id)
          VALUES (?, ?, ?, ?, 24, 256, 'allocated', 0, ?, ?)
        `,
      )
      .run(cidr, name, network, broadcast, domainName, folder).lastInsertRowid,
  );
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  folderId = Number(
    db.prepare("INSERT INTO folders (name) VALUES ('Branch offices')").run().lastInsertRowid,
  );
  subnetA = addSubnet(
    '10.20.0.0/24',
    'Alpha LAN',
    '10.20.0.0',
    '10.20.0.255',
    'shared.test',
    folderId,
  );
  subnetB = addSubnet('10.21.0.0/24', 'Beta LAN', '10.21.0.0', '10.21.0.255', 'shared.test', null);
  db.prepare(
    `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, address_family, address_sort_key)
      VALUES (?, '10.20.0.40', 'printer-alpha', 'unassigned', 4, ?)
    `,
  ).run(subnetA, '010.020.000.040');

  zoneId = Number(
    db
      .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('shared.test', 'forward', 1)")
      .run().lastInsertRowid,
  );
  db.prepare(
    `
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'host', 'A', '10.20.0.10', 'manual', 1),
             (?, 'alias', 'CNAME', 'host.shared.test', 'manual', 1),
             (?, '@', 'MX', 'mail.external.test', 'manual', 1)
    `,
  ).run(zoneId, zoneId, zoneId);
  const reverseZoneId = Number(
    db
      .prepare(
        "INSERT INTO dns_zones (name, type, enabled) VALUES ('0.20.10.in-addr.arpa', 'reverse', 1)",
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
     VALUES (?, '15', 'PTR', 'ptr-host.shared.test', 'manual', 1)`,
  ).run(reverseZoneId);

  const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const firstRange = db
    .prepare(
      `
        INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
        VALUES (?, ?, '10.20.0.10', '10.20.0.20', 'First pool')
      `,
    )
    .run(subnetA, dhcpType).lastInsertRowid;
  scopeId = Number(
    db
      .prepare('INSERT INTO dhcp_scopes (range_id, subnet_id, enabled) VALUES (?, ?, 1)')
      .run(firstRange, subnetA).lastInsertRowid,
  );
  db.prepare(
    `
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
      VALUES (?, ?, '10.20.0.10', '10.20.0.20', 0)
    `,
  ).run(scopeId, firstRange);
  const secondRange = db
    .prepare(
      `
        INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
        VALUES (?, ?, '10.20.0.30', '10.20.0.32', 'Second pool')
      `,
    )
    .run(subnetA, dhcpType).lastInsertRowid;
  db.prepare(
    `
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
      VALUES (?, ?, '10.20.0.30', '10.20.0.32', 1)
    `,
  ).run(scopeId, secondRange);
  db.prepare(
    `
      INSERT INTO dhcp_reservations
        (subnet_id, mac_address, ip_address, hostname, enabled)
      VALUES (?, '02:00:00:00:00:25', '10.20.0.25', 'outside-pool', 1)
    `,
  ).run(subnetA);
  db.prepare(
    `
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '10.20.0.11', '02:00:00:00:00:11', 'leased-host', datetime('now', '+1 day'))
    `,
  ).run(subnetA);

  app = createMultiRouterApp([
    { prefix: '/api/workspace', router: workspaceRouter },
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

describe('workspace read routes', () => {
  it('filters networks with ANDed explorer/table searches including canonical hostnames', async () => {
    const response = await request(app)
      .get('/api/workspace/networks')
      .query({ q: 'printer-alpha', table_q: 'Alpha' });

    expect(response.status).toBe(200);
    expect(response.body.items.map((row) => row.id)).toEqual([subnetA]);
    expect(response.body.total).toBe(1);
  });

  it('returns 404 for nonexistent contexts and bounds page size', async () => {
    expect((await request(app).get('/api/workspace/networks?folder_id=99999')).status).toBe(404);
    expect((await request(app).get('/api/workspace/dns-records?subnet_id=99999')).status).toBe(404);
    expect((await request(app).get('/api/workspace/dhcp-addresses?page_size=257')).status).toBe(
      400,
    );
    const legacyStatus = await request(app).get(
      '/api/workspace/dhcp-addresses?lease_status=expired',
    );
    expect(legacyStatus.status).toBe(400);
    expect(legacyStatus.body.error).toContain('offline');
  });

  it('associates address records and bounded managed CNAMEs by target address', async () => {
    const response = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, table_q: 'alias' });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({
      record_fqdn: 'alias.shared.test',
      record_type: 'CNAME',
    });
    expect(response.body.items[0].related_subnet_ids).toEqual([subnetA]);

    const otherNetwork = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetB });
    expect(otherNetwork.body.total).toBe(0);

    const wholeZone = await request(app)
      .get('/api/workspace/dns-records')
      .query({ zone_id: zoneId, record_type: 'MX' });
    expect(wholeZone.body.items).toHaveLength(1);
    expect(wholeZone.body.items[0].related_subnet_ids).toEqual([]);

    const ptr = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, record_type: 'PTR' });
    expect(ptr.body.items[0]).toMatchObject({
      ip_address: '10.20.0.15',
      related_subnet_ids: [subnetA],
    });
  });

  it('matches one address exactly with ip_address, unlike the substring table_q', async () => {
    const substring = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, table_q: '10.20.0.1' });
    expect(substring.body.items.map((row) => row.ip_address)).toEqual(
      expect.arrayContaining(['10.20.0.10', '10.20.0.15']),
    );

    const exact = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, ip_address: '10.20.0.10' });
    expect(exact.status).toBe(200);
    expect(exact.body.items.map((row) => [row.record_type, row.ip_address])).toEqual([
      ['A', '10.20.0.10'],
    ]);
    const none = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, ip_address: '10.20.0.1' });
    expect(none.body.total).toBe(0);

    const dhcp = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, ip_address: '10.20.0.25' });
    expect(dhcp.body.items.map((row) => [row.dhcp_assignment_type, row.ip_address])).toEqual([
      ['reserved', '10.20.0.25'],
    ]);
    const dhcpNone = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, ip_address: '10.20.0.2' });
    expect(dhcpNone.body.total).toBe(0);

    const invalid = await request(app)
      .get('/api/workspace/dns-records')
      .query({ ip_address: 'not-an-ip' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain('ip_address');
  });

  it('keeps IPv6 and unlinked DNS records out of IPv4 subnet association', async () => {
    // AAAA is already recognized by the read projection although the current
    // record schema does not yet expose it for CRUD. Bypass that legacy check
    // here to lock down the family boundary before IPv6 record CRUD arrives.
    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
         VALUES (?, 'v6-host', 'AAAA', '2001:db8::20', 'manual', 1),
                (?, 'external-v4', 'A', '192.0.2.10', 'manual', 1)`,
      ).run(zoneId, zoneId);

      const wholeZone = await request(app)
        .get('/api/workspace/dns-records')
        .query({ zone_id: zoneId, table_q: 'v6-host' });
      expect(wholeZone.status).toBe(200);
      expect(wholeZone.body.items[0]).toMatchObject({
        record_type: 'AAAA',
        ip_address: '2001:db8::20',
        related_subnet_ids: [],
        subnet_id: null,
      });

      const network = await request(app)
        .get('/api/workspace/dns-records')
        .query({ subnet_id: subnetA, table_q: 'v6-host' });
      expect(network.status).toBe(200);
      expect(network.body.total).toBe(0);

      const external = await request(app)
        .get('/api/workspace/dns-records')
        .query({ subnet_id: subnetA, table_q: 'external-v4' });
      expect(external.status).toBe(200);
      expect(external.body.total).toBe(0);
    } finally {
      db.prepare("DELETE FROM dns_records WHERE name IN ('v6-host', 'external-v4')").run();
      db.pragma('ignore_check_constraints = OFF');
    }
  });

  it('uses zone and related-network membership for folder DNS filters', async () => {
    const response = await request(app)
      .get('/api/workspace/dns-records')
      .query({ folder_id: folderId });

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(3);
  });

  it('includes an out-of-pool reservation in network view but not scope view', async () => {
    const network = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, q: 'outside-pool' });
    expect(network.status).toBe(200);
    expect(network.body.items).toHaveLength(1);
    expect(network.body.items[0]).toMatchObject({
      ip_address: '10.20.0.25',
      dhcp_assignment_type: 'reserved',
      scope_id: null,
      related_scope_ids: [],
    });

    const scope = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: scopeId, q: 'outside-pool' });
    expect(scope.status).toBe(200);
    expect(scope.body.total).toBe(0);
  });

  it('preserves multi-pool gaps and overlays leases without duplicate addresses', async () => {
    const response = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: scopeId, page_size: 50 });

    expect(response.status).toBe(200);
    const addresses = response.body.items.map((row) => row.ip_address);
    expect(response.body.total).toBe(14);
    expect(addresses.filter((ip) => ip === '10.20.0.11')).toHaveLength(1);
    expect(addresses).toContain('10.20.0.30');
    expect(addresses).not.toContain('10.20.0.25');
  });

  it('pages a very large pool without materializing the address range', async () => {
    const largeSubnet = addSubnet(
      '11.0.0.0/8',
      'Large pool',
      '11.0.0.0',
      '11.255.255.255',
      null,
      null,
    );
    const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const rangeId = db
      .prepare(
        `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
         VALUES (?, ?, '11.0.0.1', '11.255.255.254')`,
      )
      .run(largeSubnet, dhcpType).lastInsertRowid;
    const largeScope = Number(
      db
        .prepare('INSERT INTO dhcp_scopes (range_id, subnet_id, enabled) VALUES (?, ?, 1)')
        .run(rangeId, largeSubnet).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
       VALUES (?, ?, '11.0.0.1', '11.255.255.254', 0)`,
    ).run(largeScope, rangeId);

    const response = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: largeScope, page: 2, page_size: 3 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(16777214);
    expect(response.body.items.map((row) => row.ip_address)).toEqual([
      '11.0.0.4',
      '11.0.0.5',
      '11.0.0.6',
    ]);

    const highPage = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: largeScope, page: 5000000, page_size: 3 });
    expect(highPage.body.items[0].ip_address).toBe('11.228.225.190');
  });

  it('uses the canonical offline status for retained expired lease history', async () => {
    db.prepare(
      `INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
       VALUES (?, '10.20.0.12', '02:00:00:00:00:12', 'old-lease', datetime('now', '-1 day'))`,
    ).run(subnetA);

    const workspace = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, q: 'old-lease' });
    expect(workspace.body.items[0].lease_status).toBe('offline');

    const legacy = await request(app).get('/api/dhcp/leases');
    expect(legacy.body.find((row) => row.hostname === 'old-lease').lease_status).toBe('offline');
  });
});

describe('extended inventory routes', () => {
  it('filters DNS zones while preserving the no-query response shape', async () => {
    const legacy = await request(app).get('/api/dns/zones');
    expect(legacy.status).toBe(200);
    expect(legacy.body[0].related_subnet_ids).toEqual([subnetA, subnetB]);
    expect(legacy.body[0].related_networks).toHaveLength(2);

    const filtered = await request(app)
      .get('/api/dns/zones')
      .query({ subnet_id: subnetB, q: 'alias', include_networks: true });
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].related_subnet_ids).toEqual([subnetA, subnetB]);
  });

  it('filters DHCP scopes by either pool interval and member hostname', async () => {
    const bySecondPool = await request(app).get('/api/dhcp/scopes').query({ q: '10.20.0.31' });
    expect(bySecondPool.status).toBe(200);
    expect(bySecondPool.body.map((scope) => scope.id)).toEqual([scopeId]);

    const byHostname = await request(app).get('/api/dhcp/scopes').query({ table_q: 'leased-host' });
    expect(byHostname.status).toBe(200);
    expect(byHostname.body.map((scope) => scope.id)).toEqual([scopeId]);
  });

  it('handles IPv6 DHCP scope searches without passing them to IPv4 range math', async () => {
    db.prepare("UPDATE dhcp_scopes SET description = 'IPv6 relay 2001:db8::20' WHERE id = ?").run(
      scopeId,
    );
    try {
      const textualMatch = await request(app).get('/api/dhcp/scopes').query({ q: '2001:db8::20' });
      expect(textualMatch.status).toBe(200);
      expect(textualMatch.body.map((scope) => scope.id)).toEqual([scopeId]);

      const noMatch = await request(app).get('/api/dhcp/scopes').query({ table_q: '2001:db8::21' });
      expect(noMatch.status).toBe(200);
      expect(noMatch.body).toEqual([]);
    } finally {
      db.prepare('UPDATE dhcp_scopes SET description = NULL WHERE id = ?').run(scopeId);
    }
  });
});
