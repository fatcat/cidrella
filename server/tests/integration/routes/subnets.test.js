import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// Stub filesystem-dependent utilities so they don't write dnsmasq/dhcp configs
vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    generateReverseNames: original.generateReverseNames
  };
});

vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateDhcpConfigs: vi.fn()
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
    const res = await request(app)
      .post('/api/subnets')
      .send({ name: 'No CIDR' });

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
    const allSubnets = res.body.folders.flatMap(folder => folder.subnets || []);
    const testSubnet = allSubnets.find(s => s.cidr === '10.0.0.0/16');
    expect(testSubnet).toBeDefined();
    expect(testSubnet.name).toBe('Test Supernet');
  });
});

describe('GET /api/subnets/:id', () => {
  it('returns a subnet by ID', async () => {
    // First find the ID
    const listRes = await request(app).get('/api/subnets');
    const allSubnets = listRes.body.folders.flatMap(f => f.subnets || []);
    const subnet = allSubnets.find(s => s.cidr === '10.0.0.0/16');

    const res = await request(app).get(`/api/subnets/${subnet.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cidr).toBe('10.0.0.0/16');
  });

  it('returns 404 for nonexistent ID', async () => {
    const res = await request(app).get('/api/subnets/99999');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/subnets/:id/ips', () => {
  it('classifies online unbacked DHCP lease history as rogue', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.77.0.0/24', name: 'Lease History', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.77.0.10', '10.77.0.100', 'DHCP')
    `).run(createRes.body.id, scopeType.id);
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, status, is_online, detection_source, last_seen_at)
      VALUES (?, '10.77.0.20', 'restored-lease', '00:11:22:33:44:55', 'dhcp', 1, 'dhcp_lease', datetime('now'))
    `).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find(ip => ip.ip_address === '10.77.0.20');
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
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.78.0.10', '10.78.0.100', 'DHCP')
    `).run(createRes.body.id, scopeType.id);
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, status, is_online, detection_source, last_seen_at)
      VALUES (?, '10.78.0.20', 'restored-lease', '00:11:22:33:44:56', 'available', 0, 'dhcp_lease', datetime('now'))
    `).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find(ip => ip.ip_address === '10.78.0.20');
    expect(row).toBeDefined();
    expect(row.computed_type).toBe('available');
  });

  it('does not classify stale scanner/DHCP hostnames as static DNS without a backing A record', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.75.0.0/24', name: 'Stale Hostname', status: 'allocated' });
    expect(createRes.status).toBe(201);

    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, mac_address, status, is_online, detection_source, last_seen_at)
      VALUES (?, '10.75.0.17', 'espressif', 'd4:8c:49:17:52:b0', 'dhcp', 0, 'scanner', datetime('now'))
    `).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find(ip => ip.ip_address === '10.75.0.17');
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
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.79.0.10', '10.79.0.100', 'DHCP')
    `).run(createRes.body.id, scopeType.id);
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, status, is_online, detection_source, last_seen_at)
      VALUES (?, '10.79.0.20', 'printer.example.test', 'available', 1, 'dns', datetime('now'))
    `).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find(ip => ip.ip_address === '10.79.0.20');
    expect(row).toBeDefined();
    expect(row.computed_type).toBe('static DNS');
  });

  it('classifies backing DNS records as static DNS even when detection_source is stale', async () => {
    const createRes = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.76.0.0/24', name: 'Stale DNS Source', status: 'allocated' });
    expect(createRes.status).toBe(201);

    const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '10.76.0.10', '10.76.0.100', 'DHCP')
    `).run(createRes.body.id, scopeType.id);
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('stale-source.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'testerella', 'A', '10.76.0.20', 'manual', 1)
    `).run(zone.lastInsertRowid);
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, hostname, status, is_online, detection_source, last_seen_at)
      VALUES (?, '10.76.0.20', 'testerella.stale-source.test', 'available', 1, 'scanner', datetime('now'))
    `).run(createRes.body.id);

    const res = await request(app).get(`/api/subnets/${createRes.body.id}/ips?page=1&pageSize=64`);
    expect(res.status).toBe(200);
    const row = res.body.ips.find(ip => ip.ip_address === '10.76.0.20');
    expect(row).toBeDefined();
    expect(row.has_static_dns).toBe(1);
    expect(row.computed_type).toBe('static DNS');
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
