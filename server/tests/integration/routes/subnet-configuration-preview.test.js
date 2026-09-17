import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', () => ({ regenerateDnsmasqConfig: vi.fn() }));
vi.mock('../../../src/utils/dhcp.js', () => ({ regenerateDhcpConfig: vi.fn() }));

const { default: request } = await import('supertest');
const { default: subnetsRouter } = await import('../../../src/routes/subnets.js');

let app;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  setup.db
    .prepare(
      "UPDATE settings SET value = '%1-%2-%3-%4-%bitmask' WHERE key = 'subnet_name_template'",
    )
    .run();
  setup.db
    .prepare("UPDATE settings SET value = 'last' WHERE key = 'default_gateway_position'")
    .run();
  app = createTestApp(subnetsRouter, '/api/subnets');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('subnet configuration preview', () => {
  it('normalizes CIDR and resolves name, gateway, and DHCP defaults without writing', async () => {
    const response = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: '10.20.30.42/24' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      cidr: '10.20.30.0/24',
      address_family: 4,
      dhcp_v6_modes: null,
      gateway_policy: 'last',
      gateway_address: '10.20.30.254',
      suggested_name: '10-20-30-0-24',
      default_dhcp_pool: { start_ip: '10.20.30.33', end_ip: '10.20.30.64' },
      default_dhcp_pool_explanation: null,
    });
    expect(setupCount(await request(app).get('/api/subnets'))).toBe(0);
  });

  it('recomputes a gateway-safe pool and explains unsupported automatic pools', async () => {
    const custom = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: '10.20.31.0/24', gateway_policy: 'custom', gateway_address: '10.20.31.33' });
    expect(custom.status).toBe(200);
    expect(custom.body.gateway_address).toBe('10.20.31.33');
    expect(custom.body.default_dhcp_pool.start_ip).toBe('10.20.31.34');

    const large = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: '10.0.0.0/8', gateway_policy: 'none' });
    expect(large.status).toBe(200);
    expect(large.body.default_dhcp_pool).toBeNull();
    expect(large.body.default_dhcp_pool_explanation).toContain('No automatic DHCP pool');
  });

  it('requires an explicit custom gateway and validates containment', async () => {
    const missing = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: '10.20.30.0/24', gateway_policy: 'custom' });
    expect(missing.status).toBe(400);

    const outside = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: '10.20.30.0/24', gateway_address: '10.20.31.1' });
    expect(outside.status).toBe(400);
  });
});

function setupCount(response) {
  return response.body.folders.reduce((total, folder) => total + folder.subnets.length, 0);
}
