/**
 * Point-to-point and host prefixes reserve nothing (RFC 3021 for IPv4 /31,
 * RFC 6164 for IPv6 /127; /32 and /128 are one host). Every address of them
 * is usable, so none reads as a protected system address (IPV6-06).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    applyInterfaceConfig: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    signalDnsmasq: vi.fn(),
    restartDnsmasq: vi.fn(),
  };
});
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn(), startLeaseWatcher: vi.fn() };
});

const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  const subnets = await import('../../../src/routes/subnets.js');
  app = createMultiRouterApp([{ prefix: '/api/subnets', router: subnets.default }]);
});

afterAll(() => cleanupTestDb(tmpDir));

async function network(cidr) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, gateway_policy: 'none' });
  expect(configured.status).toBe(200);
  return created.body.id;
}

describe.each([
  ['fd00:3::/127', ['fd00:3::', 'fd00:3::1']],
  ['10.30.0.0/31', ['10.30.0.0', '10.30.0.1']],
])('%s', (cidr, addresses) => {
  it('reads and reserves both addresses as ordinary ones', async () => {
    const id = await network(cidr);
    for (const ip of addresses) {
      const row = await request(app).get(`/api/subnets/${id}/ips`).query({ search: ip });
      expect(row.body.ips.find((r) => r.ip_address === ip)).toMatchObject({
        allocation_state: 'unassigned',
      });
      const reserve = await request(app)
        .put(`/api/subnets/${id}/ips/${ip}/allocation`)
        .send({ allocation_state: 'reserved' });
      expect([ip, reserve.status]).toEqual([ip, 200]);
    }
  });
});

describe('a normal prefix still protects its network address', () => {
  it.each([
    ['fd00:4::/64', 'fd00:4::'],
    ['10.31.0.0/24', '10.31.0.0'],
    ['10.32.0.0/24', '10.32.0.255'],
  ])('%s refuses %s', async (cidr, ip) => {
    const id = await network(cidr);
    const reserve = await request(app)
      .put(`/api/subnets/${id}/ips/${ip}/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(reserve.status).toBe(400);
  });
});
