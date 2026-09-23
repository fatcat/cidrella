import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import workspaceRouter from '../../../src/routes/workspace.js';
import dnsRouter from '../../../src/routes/dns.js';
import dhcpRouter from '../../../src/routes/dhcp.js';
import subnetRouter from '../../../src/routes/subnets.js';

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
  enableIpv6(db);
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
  // The lifecycle row the lease sync would have written for that lease.
  db.prepare(
    `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, allocation_source_type,
         address_family, address_sort_key)
      VALUES (?, '10.20.0.11', 'leased-host', 'dynamic_dhcp', 'dhcp_lease', 4, ?)
    `,
  ).run(subnetA, '010.020.000.011');

  app = createMultiRouterApp([
    { prefix: '/api/workspace', router: workspaceRouter },
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
    { prefix: '/api/subnets', router: subnetRouter },
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
    expect((await request(app).get('/api/workspace/dhcp-addresses?page_size=513')).status).toBe(
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

  it('reports a free pool address as offline, not unknown', async () => {
    const response = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: scopeId, page_size: 50 });
    const free = response.body.items.filter((row) => row.lease_status === 'available');
    expect(free.length).toBeGreaterThan(0);
    // Nothing has ever answered at these addresses. The table printed
    // "unknown" for them because is_online was left unset; offline is the
    // reading every other synthesized row gets.
    for (const row of free) expect([0, false]).toContain(row.is_online);
  });

  it('gives every pool row the status and lease state the Addresses table shows', async () => {
    const response = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ scope_id: scopeId, page_size: 50 });
    const byIp = new Map(response.body.items.map((row) => [row.ip_address, row]));
    // A free pool address, synthesized or stored, reads "DHCP Scope" as it
    // does in the Addresses table, and carries no lease.
    expect(byIp.get('10.20.0.10')).toMatchObject({
      ip_display_status: 'DHCP Scope',
      dhcp_lease_state: null,
    });
    // A leased pool address is in use with an active lease and its expiry.
    expect(byIp.get('10.20.0.11')).toMatchObject({
      ip_display_status: 'in use',
      dhcp_lease_state: 'active',
    });
    expect(byIp.get('10.20.0.11').dhcp_expires_at).toBeTruthy();
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
    expect(workspace.body.items[0].dhcp_lease_state).toBe('expired');

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

// Addresses, DNS and DHCP are one table model: each read carries the facts the
// other two tables have about an address, so any column shows on any table.
describe('one IP table model', () => {
  it('shows the same DNS and DHCP facts for one address in all three reads', async () => {
    db.prepare(
      `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
       VALUES (?, 'leased-host', 'A', '10.20.0.11', 'dhcp', 1)`,
    ).run(zoneId);

    const dhcp = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, table_q: '10.20.0.11' });
    const dns = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, table_q: 'leased-host' });
    const addresses = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ table_search: '10.20.0.11', pageSize: 32 });

    const dhcpRow = dhcp.body.items.find((row) => row.ip_address === '10.20.0.11');
    const dnsRow = dns.body.items.find((row) => row.record_type === 'A');
    const addressRow = addresses.body.ips.find((row) => row.ip_address === '10.20.0.11');

    const record = {
      record_fqdn: 'leased-host.shared.test',
      record_type: 'A',
      value: '10.20.0.11',
      dns_source: 'dhcp',
    };
    expect(dhcpRow.dns_record).toMatchObject(record);
    expect(addressRow.dns_record).toMatchObject(record);
    expect(dnsRow).toMatchObject(record);

    const lease = {
      dhcp_assignment_type: 'dynamic',
      lease_status: 'active',
      related_scope_ids: [scopeId],
    };
    expect(dnsRow.dhcp).toMatchObject(lease);
    expect(addressRow.dhcp).toMatchObject(lease);
    expect(dhcpRow).toMatchObject(lease);

    expect(addressRow.subnet_name).toBe('Alpha LAN');
    expect(dhcpRow.subnet_name).toBe('Alpha LAN');
  });

  it('attaches nothing to an address no record or lease names', async () => {
    const addresses = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ table_search: '10.20.0.40', pageSize: 32 });
    const row = addresses.body.ips.find((item) => item.ip_address === '10.20.0.40');
    expect(row.dns_record).toBeNull();
    expect(row.dns_record_count).toBe(0);
    expect(row.dhcp).toBeNull();
  });
});

describe('column filters, counts and sorting on every IP table', () => {
  const filters = (value) => JSON.stringify(value);

  it('finds a disabled record through the Record Enabled filter and counts both values', async () => {
    db.prepare(
      `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
       VALUES (?, 'parked', 'A', '10.20.0.77', 'manual', 0)`,
    ).run(zoneId);

    const response = await request(app)
      .get('/api/workspace/dns-records')
      .query({ subnet_id: subnetA, filters: filters({ record_enabled: [false] }), facets: 1 });

    expect(response.status).toBe(200);
    expect(response.body.items.map((row) => row.record_fqdn)).toEqual(['parked.shared.test']);
    const counts = Object.fromEntries(
      response.body.facets.record_enabled.map((item) => [String(item.value), item.count]),
    );
    expect(counts.false).toBe(1);
    expect(counts.true).toBeGreaterThan(0);
  });

  it('counts free pool addresses by segment and filters them by their status', async () => {
    const all = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, facets: 1, page_size: 1 });
    const scope = all.body.facets.status.find((item) => item.value === 'DHCP Scope');
    const pooled = await request(app)
      .get('/api/workspace/dhcp-addresses')
      .query({ subnet_id: subnetA, filters: filters({ status: ['DHCP Scope'] }), page_size: 512 });

    expect(pooled.status).toBe(200);
    expect(pooled.body.total).toBe(scope.count);
    expect(pooled.body.items.every((row) => row.ip_display_status === 'DHCP Scope')).toBe(true);
    const sum = all.body.facets.status.reduce((total, item) => total + item.count, 0);
    expect(sum).toBe(all.body.total);
  });

  it('counts every address of the network, free ones included, on the Addresses read', async () => {
    const response = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ facets: 1, pageSize: 32 });
    expect(response.status).toBe(200);
    const sum = response.body.facets.status.reduce((total, item) => total + item.count, 0);
    expect(sum).toBe(256);
    expect(response.body.filteredTotal).toBe(256);

    const named = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ filters: filters({ dns_hostname: ['shared.test'] }), pageSize: 32 });
    expect(named.body.ips.length).toBeGreaterThan(0);
    expect(
      named.body.ips.every((row) => row.dns_record?.record_fqdn?.includes('shared.test')),
    ).toBe(true);
  });

  it('sorts by a column another table owns', async () => {
    const response = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ sort_column: 'dns_hostname', sortOrder: 'asc', pageSize: 4 });
    expect(response.status).toBe(200);
    const names = response.body.ips.map((row) => row.dns_record?.record_fqdn).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual(names);
  });

  it('refuses a malformed filter or an unknown sort column', async () => {
    const bad = await request(app)
      .get('/api/workspace/dns-records')
      .query({ filters: '{"password":["x"]}' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown column/);
    const badSort = await request(app)
      .get(`/api/subnets/${subnetA}/ips`)
      .query({ sort_column: 'drop table' });
    expect(badSort.status).toBe(400);
  });
});
