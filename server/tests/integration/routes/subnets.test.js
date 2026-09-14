import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';
import { ADDRESS_TYPE } from '../../../src/models/ip-view.js';

// Stub filesystem-dependent utilities so they don't write dnsmasq/dhcp configs
vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    generateReverseNames: original.generateReverseNames,
  };
});

vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateDhcpConfigs: vi.fn(),
  };
});

// Import after mocks are set up
const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(subnetRouter, '/api/subnets');
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/subnets', () => {
  it('creates a supernet', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.0.0.0/16', name: 'Test Supernet' });

    expect(res.status).toBe(201);
    expect(res.body.cidr).toBe('10.0.0.0/16');
    expect(res.body.name).toBe('Test Supernet');
    expect(res.body.id).toBeDefined();
  });

  it('normalizes CIDR host bits', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: '172.16.5.100/16', name: 'Normalized' });

    expect(res.status).toBe(201);
    expect(res.body.cidr).toBe('172.16.0.0/16');
  });

  it('rejects duplicate CIDR', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.0.0.0/16', name: 'Duplicate' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('rejects overlapping CIDR', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.0.0.0/8', name: 'Overlapping' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Overlaps');
  });

  it('rejects missing CIDR', async () => {
    const res = await request(app).post('/api/subnets').send({ name: 'No CIDR' });

    expect(res.status).toBe(400);
  });

  it('rejects invalid CIDR', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: 'not-a-cidr', name: 'Invalid' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/subnets', () => {
  it('returns list including created subnets', async () => {
    const res = await request(app).get('/api/subnets');

    expect(res.status).toBe(200);
    expect(res.body.folders).toBeDefined();
    expect(Array.isArray(res.body.folders)).toBe(true);

    // Find our test subnets in the response (nested in folders)
    const allSubnets = res.body.folders.flatMap((folder) => folder.subnets || []);
    const testSubnet = allSubnets.find((s) => s.cidr === '10.0.0.0/16');
    expect(testSubnet).toBeDefined();
    expect(testSubnet.name).toBe('Test Supernet');
  });
});

describe('GET /api/subnets/:id', () => {
  it('returns a subnet by ID', async () => {
    // First find the ID
    const listRes = await request(app).get('/api/subnets');
    const allSubnets = listRes.body.folders.flatMap((f) => f.subnets || []);
    const subnet = allSubnets.find((s) => s.cidr === '10.0.0.0/16');

    const res = await request(app).get(`/api/subnets/${subnet.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cidr).toBe('10.0.0.0/16');
  });

  it('returns 404 for nonexistent ID', async () => {
    const res = await request(app).get('/api/subnets/99999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/subnets/:id/configure', () => {
  it('uses the saved last allocatable address as the default gateway', async () => {
    db.prepare("UPDATE settings SET value = 'last' WHERE key = 'default_gateway_position'").run();
    try {
      const createRes = await request(app)
        .post('/api/subnets')
        .send({ cidr: '198.51.100.0/24', name: 'Last Gateway Default' });
      expect(createRes.status).toBe(201);

      const configureRes = await request(app)
        .post(`/api/subnets/${createRes.body.id}/configure`)
        .send({
          name: 'Last Gateway Default',
          create_reverse_dns: false,
          create_dhcp_scope: false,
        });

      expect(configureRes.status).toBe(200);
      expect(configureRes.body.gateway_address).toBe('198.51.100.254');
      expect(configureRes.body.gateway_address).not.toBe('198.51.100.0');
      expect(configureRes.body.gateway_address).not.toBe('198.51.100.255');
    } finally {
      db.prepare(
        "UPDATE settings SET value = 'first' WHERE key = 'default_gateway_position'",
      ).run();
    }
  });

  it('creates an IP-valued PTR placeholder for every usable address', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '192.168.50.0/24', name: 'Reverse No Placeholders' });
    expect(createRes.status).toBe(201);

    const configureRes = await request(app)
      .post(`/api/subnets/${createRes.body.id}/configure`)
      .send({
        name: 'Reverse No Placeholders',
        create_reverse_dns: true,
        create_dhcp_scope: false,
      });
    expect(configureRes.status).toBe(200);
    expect(configureRes.body.has_reverse_dns).toBe(1);

    const zone = db
      .prepare(
        `
      SELECT id FROM dns_zones
      WHERE name = '50.168.192.in-addr.arpa' AND type = 'reverse'
    `,
      )
      .get();
    expect(zone).toBeTruthy();

    const ptrCount = db
      .prepare(
        `
      SELECT COUNT(*) AS count FROM dns_records
      WHERE zone_id = ? AND type = 'PTR'
    `,
      )
      .get(zone.id).count;
    expect(ptrCount).toBe(254);
    expect(
      db
        .prepare(
          `
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '33'
    `,
        )
        .get(zone.id),
    ).toEqual({ value: '192.168.50.33', source: 'placeholder' });
  });
});

describe('GET /api/subnets/:id/ips', () => {
  // All four query modes of this route build has_static_dns from the shared
  // staticDnsClaimSql() fragment. Only Normal mode was exercised before, so a
  // malformed fragment in the other three would have shipped silently: the SQL
  // is assembled at runtime, so it fails when the query runs, not at import.
  // See REVIEW.md, duplicate-logic audit #19.
  describe('has_static_dns is computed in every mode', () => {
    // Each mode gets its own subnet and zone: the CIDR and the zone name are
    // both unique-constrained, so a shared fixture would fail every run after
    // the first.
    async function subnetWithStaticDns(octet) {
      const cidr = `10.88.${octet}.0/24`;
      const ip = `10.88.${octet}.9`;
      const zone = `static${octet}.test`;
      const created = await request(app)
        .post('/api/subnets')
        .send({ cidr, name: `StaticDns${octet}`, status: 'allocated' });
      expect(created.status).toBe(201);
      const id = created.body.id;
      db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES (?, 'forward', 1)").run(zone);
      const zoneId = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(zone).id;
      db.prepare(
        'INSERT INTO dns_records (zone_id, type, name, value, enabled, source)' +
          " VALUES (?, 'A', 'claimed', ?, 1, 'manual')",
      ).run(zoneId, ip);
      db.prepare(
        'INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state, is_online, detection_source)' +
          " VALUES (?, ?, 'static_dns', 1, 'scanner')",
      ).run(id, ip);
      return { id, ip };
    }

    const MODES = [
      ['normal', 1, () => 'page=1&pageSize=64'],
      ['search', 2, (ip) => `page=1&pageSize=64&search=${ip}`],
      ['suppressed-available', 3, () => 'page=1&pageSize=64&showAvailable=false'],
      ['full-row sort', 4, () => 'page=1&pageSize=64&sortField=hostname&sortOrder=asc'],
    ];

    it.each(MODES)(
      '%s mode returns the claimed address as static DNS',
      async (_mode, octet, qs) => {
        const { id, ip } = await subnetWithStaticDns(octet);
        const res = await request(app).get(`/api/subnets/${id}/ips?${qs(ip)}`);
        expect(res.status).toBe(200);
        const row = (res.body.ips || res.body.data || []).find((r) => r.ip_address === ip);
        expect(row, 'claimed address missing from response').toBeDefined();
        // The claim must survive into the computed view, not just the raw column.
        expect(row.address_type).toBe(ADDRESS_TYPE.STATIC_DNS);
      },
    );
  });

  it('classifies online unbacked DHCP lease history as rogue', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.77.0.0/24', name: 'Lease History', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(
      `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.77.0.10', '10.77.0.100', 'DHCP')
    `,
    ).run(createRes.body.id, scopeType.id);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.77.0.20', 'restored-lease', '00:11:22:33:44:55', 'unassigned', 1, 'dhcp_lease', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.77.0.20');
    expect(row).toBeDefined();
    expect(row.dhcp_expires_at).toBeNull();
    expect(row.computed_type).toBe('rogue');
  });

  it('does not classify offline unbacked DHCP lease history as assigned', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.78.0.0/24', name: 'Offline Lease History', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(
      `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.78.0.10', '10.78.0.100', 'DHCP')
    `,
    ).run(createRes.body.id, scopeType.id);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.78.0.20', 'restored-lease', '00:11:22:33:44:56', 'unassigned', 0, 'dhcp_lease', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.78.0.20');
    expect(row).toBeDefined();
    expect(row.computed_type).toBe('available');
  });

  it('does not classify stale scanner/DHCP hostnames as static DNS without a backing A record', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.75.0.0/24', name: 'Stale Hostname', status: 'allocated' });
    expect(createRes.status).toBe(201);

    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.75.0.17', 'espressif', 'd4:8c:49:17:52:b0', 'unassigned', 0, 'scanner', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.75.0.17');
    expect(row).toBeDefined();
    expect(row.has_static_dns).toBe(0);
    expect(row.address_type).toBeNull();
    expect(row.computed_type).toBe('available');
  });

  it('classifies DNS-owned hostnames inside DHCP scopes as static DNS', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.79.0.0/24', name: 'DNS In Scope', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(
      `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.79.0.10', '10.79.0.100', 'DHCP')
    `,
    ).run(createRes.body.id, scopeType.id);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.79.0.20', 'printer.example.test', 'static_dns', 1, 'dns', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.79.0.20');
    expect(row).toBeDefined();
    expect(row.computed_type).toBe('static DNS');
  });

  it('classifies backing DNS records as static DNS even when detection_source is stale', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.76.0.0/24', name: 'Stale DNS Source', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(
      `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.76.0.10', '10.76.0.100', 'DHCP')
    `,
    ).run(createRes.body.id, scopeType.id);
    const zone = db
      .prepare(
        "INSERT INTO dns_zones (name, type, enabled) VALUES ('stale-source.test', 'forward', 1)",
      )
      .run();
    db.prepare(
      `
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'testerella', 'A', '10.76.0.20', 'manual', 1)
    `,
    ).run(zone.lastInsertRowid);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.76.0.20', 'testerella.stale-source.test', 'static_dns', 1, 'scanner', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.76.0.20');
    expect(row).toBeDefined();
    expect(row.has_static_dns).toBe(1);
    expect(row.computed_type).toBe('static DNS');
  });

  it('keeps virtual empty rows when sorting by a nullable column', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.74.0.0/29', name: 'Nullable Sort', status: 'allocated' });
    expect(createRes.status).toBe(201);

    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.74.0.3', 'named-host', 'static_dns', 0, 'manual', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(
      `/api/subnets/${createRes.body.id}/ips?page=1&pageSize=8&sortField=hostname&sortOrder=asc`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalIps).toBe(8);
    expect(res.body.ips).toHaveLength(8);
    expect(res.body.ips[0].ip_address).toBe('10.74.0.3');
    expect(res.body.ips[0].hostname).toBe('named-host');
    expect(res.body.ips.some((ip) => ip.ip_address === '10.74.0.4' && ip.hostname === null)).toBe(
      true,
    );
  });

  it('suppresses available rows when requested', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.73.0.0/29', name: 'Hide Available', status: 'allocated' });
    expect(createRes.status).toBe(201);

    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, is_online, detection_source, last_seen_at)
      VALUES (?, '10.73.0.3', 'assigned-host', 'static_dns', 0, 'manual', datetime('now'))
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(
      `/api/subnets/${createRes.body.id}/ips?page=1&pageSize=8&showAvailable=false`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalIps).toBe(3);
    expect(res.body.ips.map((ip) => ip.ip_address)).toEqual([
      '10.73.0.0',
      '10.73.0.3',
      '10.73.0.7',
    ]);
    expect(res.body.ips.every((ip) => ip.ip_display_status !== 'available')).toBe(true);
  });

  it('classifies a persisted gateway allocation when available rows are suppressed', async () => {
    const createRes = await request(app).post('/api/subnets').send({
      cidr: '10.72.0.0/29',
      name: 'Gateway Type',
      status: 'allocated',
      gateway_address: '10.72.0.1',
    });
    expect(createRes.status).toBe(201);

    const gatewayType = db
      .prepare("SELECT id FROM range_types WHERE name = 'Gateway' AND is_system = 1")
      .get();
    db.prepare(
      `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.72.0.1', '10.72.0.1', 'Default gateway')
    `,
    ).run(createRes.body.id, gatewayType.id);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, allocation_state, reservation_note)
      VALUES (?, '10.72.0.1', 'gateway', 'Default gateway')
    `,
    ).run(createRes.body.id);

    const res = await request(app).get(
      `/api/subnets/${createRes.body.id}/ips?page=1&pageSize=8&showAvailable=false`,
    );
    expect(res.status).toBe(200);
    const row = res.body.ips.find((ip) => ip.ip_address === '10.72.0.1');
    expect(row).toBeDefined();
    expect(row.range_type_name).toBe('Gateway');
    expect(row.address_type).toBe('gateway');
    expect(row.computed_type).toBe('gateway');
  });

  it('applies workspace searches and filters before pagination', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.71.0.0/29', name: 'Filtered addresses', status: 'allocated' });
    expect(created.status).toBe(201);

    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, allocation_state, is_online, detection_source)
      VALUES
        (?, '10.71.0.3', 'alpha-printer', 'reserved', 1, 'manual'),
        (?, '10.71.0.4', 'beta-printer', 'reserved', 0, 'manual')
    `,
    ).run(created.body.id, created.body.id);

    const res = await request(app).get(`/api/subnets/${created.body.id}/ips`).query({
      search: 'printer',
      table_search: 'beta',
      display_status: 'in use',
      address_type: 'IP Reservation',
      online: 'false',
      page: 1,
      pageSize: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.totalIps).toBe(8);
    expect(res.body.filteredTotal).toBe(1);
    expect(res.body.ips.map((row) => row.ip_address)).toEqual(['10.71.0.4']);
  });

  it('returns an exact unused explorer IP without persisting it and rejects malformed filters', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.70.0.0/29', name: 'Virtual filtering', status: 'allocated' });
    expect(created.status).toBe(201);

    const available = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ search: '10.70.0.5', display_status: 'available' });
    expect(available.status).toBe(200);
    expect(available.body.totalIps).toBe(8);
    expect(available.body.filteredTotal).toBe(1);
    expect(available.body.ips[0]).toMatchObject({
      ip_address: '10.70.0.5',
      allocation_state: 'unassigned',
      ip_display_status: 'available',
    });
    const tableOnly = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ table_search: '10.70.0.6', display_status: 'available' });
    expect(tableOnly.status).toBe(200);
    expect(tableOnly.body.totalIps).toBe(8);
    expect(tableOnly.body.filteredTotal).toBe(0);
    expect(tableOnly.body.ips).toEqual([]);

    const invalidBoolean = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ online: 'sometimes' });
    expect(invalidBoolean.status).toBe(400);

    const invalidRange = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ network_range_type_id: 'not-an-id' });
    expect(invalidRange.status).toBe(400);
  });

  it('filters addresses by their canonical user-owned network range type', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.66.0.0/24', name: 'Range filtering', status: 'allocated' });
    expect(created.status).toBe(201);
    const customType = db
      .prepare(
        `INSERT INTO range_types (name, color, is_system, description)
         VALUES ('Workstations filter', '#334455', 0, 'Workspace regression')`,
      )
      .run();
    db.prepare(
      `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
         VALUES (?, ?, '10.66.0.32', '10.66.0.63', 'Workspace filter')`,
    ).run(created.body.id, customType.lastInsertRowid);

    const filtered = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ network_range_type_id: customType.lastInsertRowid, pageSize: 8 });
    expect(filtered.status).toBe(200);
    expect(filtered.body.filteredTotal).toBe(32);
    expect(filtered.body.ips).toHaveLength(8);
    expect(filtered.body.ips[0]).toMatchObject({
      ip_address: '10.66.0.32',
      network_range_type_id: Number(customType.lastInsertRowid),
      network_range_type: 'Workstations filter',
      allocation_state: 'unassigned',
      ip_display_status: 'available',
    });
  });

  it('filters protocol ownership from the canonical allocation source', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.65.0.0/29', name: 'Protocol filtering', status: 'allocated' });
    expect(created.status).toBe(201);
    db.prepare(
      `INSERT INTO ip_addresses
         (subnet_id, ip_address, allocation_state, allocation_source_type, allocation_source_id)
       VALUES (?, '10.65.0.3', 'static_dns', 'dns_record', '41'),
              (?, '10.65.0.4', 'reserved', 'manual', '42')`,
    ).run(created.body.id, created.body.id);

    const filtered = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ allocation_source_type: 'dns_record' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.filteredTotal).toBe(1);
    expect(filtered.body.ips[0]).toMatchObject({
      ip_address: '10.65.0.3',
      allocation_source_type: 'dns_record',
    });
  });

  it('filters a large prefix without persisting or materializing its virtual addresses', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '11.0.0.0/8', name: 'Large virtual filtering', status: 'allocated' });
    expect(created.status).toBe(201);

    const beforeRows = db
      .prepare('SELECT COUNT(*) AS count FROM ip_addresses WHERE subnet_id = ?')
      .get(created.body.id).count;
    const exact = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ search: '11.200.100.50', display_status: 'available' });
    expect(exact.status).toBe(200);
    expect(exact.body.totalIps).toBe(16777216);
    expect(exact.body.filteredTotal).toBe(1);
    expect(exact.body.ips).toHaveLength(1);
    expect(exact.body.ips[0]).toMatchObject({
      ip_address: '11.200.100.50',
      allocation_state: 'unassigned',
      ip_display_status: 'available',
    });

    const offline = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ online: 'false', page: 32768, pageSize: 512 });
    expect(offline.status).toBe(200);
    expect(offline.body.filteredTotal).toBe(16777216);
    expect(offline.body.ips).toHaveLength(512);
    expect(offline.body.ips[0].ip_address).toBe('11.255.254.0');
    expect(offline.body.ips[511].ip_address).toBe('11.255.255.255');

    const sorted = await request(app)
      .get(`/api/subnets/${created.body.id}/ips`)
      .query({ sortField: 'hostname', sortOrder: 'asc', page: 32768, pageSize: 512 });
    expect(sorted.status).toBe(200);
    expect(sorted.body.totalIps).toBe(16777216);
    expect(sorted.body.filteredTotal).toBe(16777216);
    expect(sorted.body.ips).toHaveLength(512);

    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM ip_addresses WHERE subnet_id = ?')
        .get(created.body.id).count,
    ).toBe(beforeRows);
  });
});

describe('canonical subnet IP detail and summary reads', () => {
  it('returns an available virtual detail without persisting it', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.69.0.0/29', name: 'Detail read', status: 'allocated' });
    expect(created.status).toBe(201);
    const beforeRows = db
      .prepare('SELECT COUNT(*) AS count FROM ip_addresses WHERE subnet_id = ?')
      .get(created.body.id).count;
    const beforeEvents = db
      .prepare('SELECT COUNT(*) AS count FROM ip_events WHERE subnet_id = ?')
      .get(created.body.id).count;

    const detail = await request(app).get(`/api/subnets/${created.body.id}/ips/10.69.0.5`);
    expect(detail.status).toBe(200);
    expect(detail.body.ip).toMatchObject({
      ip_address: '10.69.0.5',
      subnet_id: created.body.id,
      allocation_state: 'unassigned',
      ip_display_status: 'available',
      address_type: null,
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM ip_addresses WHERE subnet_id = ?')
        .get(created.body.id).count,
    ).toBe(beforeRows);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM ip_events WHERE subnet_id = ?').get(created.body.id)
        .count,
    ).toBe(beforeEvents);
  });

  it('validates detail identity and containment', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.68.0.0/29', name: 'Detail validation', status: 'allocated' });
    expect(created.status).toBe(201);

    expect((await request(app).get(`/api/subnets/${created.body.id}/ips/not-an-ip`)).status).toBe(
      400,
    );
    expect((await request(app).get(`/api/subnets/${created.body.id}/ips/10.68.1.1`)).status).toBe(
      400,
    );
    expect((await request(app).get('/api/subnets/999999/ips/10.68.0.1')).status).toBe(404);
  });

  it('summarizes canonical allocation, liveness and rogue classifications', async () => {
    const created = await request(app).post('/api/subnets').send({
      cidr: '10.67.0.0/29',
      name: 'Summary read',
      status: 'allocated',
      gateway_address: '10.67.0.1',
    });
    expect(created.status).toBe(201);
    db.prepare(
      `
      INSERT INTO ip_addresses
        (subnet_id, ip_address, allocation_state, is_online, is_rogue, detection_source)
      VALUES
        (?, '10.67.0.3', 'reserved', 1, 1, 'manual'),
        (?, '10.67.0.4', 'unassigned', 1, 1, 'scanner'),
        (?, '10.67.0.5', 'unassigned', 0, 0, 'scanner')
    `,
    ).run(created.body.id, created.body.id, created.body.id);

    const summary = await request(app).get(`/api/subnets/${created.body.id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      subnet_id: created.body.id,
      total_addresses: 8,
      assigned_count: 3,
      unassigned_count: 5,
      online_count: 2,
      rogue_count: 1,
    });
  });
});

describe('gateway policy edits', () => {
  it('supports explicit none and releases the former gateway topology claim', async () => {
    const create = await request(app)
      .post('/api/subnets')
      .send({ cidr: '203.0.113.248/29', name: 'Gateway policy edit' });
    expect(create.status).toBe(201);
    const configured = await request(app).post(`/api/subnets/${create.body.id}/configure`).send({
      name: 'Gateway policy edit',
      gateway_policy: 'last',
      create_reverse_dns: false,
      create_dhcp_scope: false,
    });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({
      gateway_policy: 'last',
      gateway_address: '203.0.113.254',
    });

    const cleared = await request(app)
      .put(`/api/subnets/${create.body.id}`)
      .send({ gateway_policy: 'none' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ gateway_policy: 'none', gateway_address: null });
    expect(
      db
        .prepare(
          `
      SELECT allocation_state FROM ip_addresses
      WHERE subnet_id = ? AND ip_address = '203.0.113.254'
    `,
        )
        .get(create.body.id).allocation_state,
    ).toBe('unassigned');
  });
});

describe('DELETE /api/subnets/:id', () => {
  it('deletes a subnet', async () => {
    // Create one to delete
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '192.168.99.0/24', name: 'To Delete' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const delRes = await request(app).delete(`/api/subnets/${id}`);
    expect(delRes.status).toBe(200);

    // Verify it's gone
    const getRes = await request(app).get(`/api/subnets/${id}`);
    expect(getRes.status).toBe(404);
  });
});
