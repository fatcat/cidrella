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

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
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
    expect(Array.isArray(res.body)).toBe(true);

    // Find our test subnets in the response (may be nested in folders)
    const allSubnets = res.body.flatMap(folder => folder.subnets || []);
    const testSubnet = allSubnets.find(s => s.cidr === '10.0.0.0/16');
    expect(testSubnet).toBeDefined();
    expect(testSubnet.name).toBe('Test Supernet');
  });
});

describe('GET /api/subnets/:id', () => {
  it('returns a subnet by ID', async () => {
    // First find the ID
    const listRes = await request(app).get('/api/subnets');
    const allSubnets = listRes.body.flatMap(f => f.subnets || []);
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
