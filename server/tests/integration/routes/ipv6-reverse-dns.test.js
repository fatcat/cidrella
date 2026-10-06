/**
 * Reverse DNS for IPv6, beside the IPv4 behaviour it should match or, by the
 * canonical model, deliberately differ from: PTRs only for allocated IPv6
 * addresses, zones at the nibble boundary (31 nibbles at most), PTR names that
 * spell an address, and cleanup of a divided network's PTRs wherever they live.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', async (importOriginal) => {
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
vi.mock('../../../src/backends/dnsmasq/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn(), startLeaseWatcher: vi.fn() };
});
vi.mock('../../../src/utils/encrypted-forwarder.js', () => ({
  applyEncryptedForwarder: vi.fn(),
  getEncryptedForwarderStatus: vi.fn(() => ({ running: false })),
}));

const { default: request } = await import('supertest');
const { generateReverseNames } = await import('../../../src/utils/reverse-zones.js');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  const [subnets, dns, dhcp] = await Promise.all([
    import('../../../src/routes/subnets.js'),
    import('../../../src/routes/dns.js'),
    import('../../../src/routes/dhcp.js'),
  ]);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnets.default },
    { prefix: '/api/dns', router: dns.default },
    { prefix: '/api/dhcp', router: dhcp.default },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

async function network(cidr, body = {}) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, gateway_policy: 'first', create_reverse_dns: true, ...body });
  expect(configured.status).toBe(200);
  return created.body.id;
}

const ptrValues = () =>
  db
    .prepare("SELECT value FROM dns_records WHERE type = 'PTR' AND enabled = 1")
    .all()
    .map((row) => row.value);

describe('deallocating a divided network (IPV6-25)', () => {
  it("takes the child's PTRs out of the parent's nibble zone", async () => {
    // A /63 has a 15-nibble zone; its /64 children have none of their own, so
    // their PTRs (here the anycast and gateway placeholders) live in it.
    const parent = await network('fd00:16::/63');
    expect(ptrValues()).toEqual(expect.arrayContaining(['fd00:16::', 'fd00:16::1']));
    const divided = await request(app)
      .post(`/api/subnets/${parent}/divide`)
      .send({ new_prefix: 64, force: true });
    expect(divided.status).toBe(200);
    const child = db.prepare("SELECT id FROM subnets WHERE cidr = 'fd00:16::/64'").get().id;

    const preview = await request(app).get(`/api/subnets/${child}/deallocation-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.generated_ptr).toBeGreaterThan(0);

    const removed = await request(app).delete(`/api/subnets/${child}`);
    expect(removed.status).toBe(200);
    expect(ptrValues()).not.toContain('fd00:16::');
    expect(ptrValues()).not.toContain('fd00:16::1');
  });
});

describe('releasing an IPv6 address drops its placeholder PTR (IPV6-26)', () => {
  it('after a DHCP reservation goes; IPv4 keeps its placeholder', async () => {
    const v6 = await network('fd00:17::/64', {
      domain_name: 'r6.test',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    const v4 = await network('10.61.0.0/24', { domain_name: 'r4.test', create_dhcp_scope: true });
    const reservations = [
      { subnet_id: v6, ip_address: 'fd00:17::20', duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:20' },
      { subnet_id: v4, ip_address: '10.61.0.20', mac_address: 'aa:bb:cc:dd:ee:20' },
    ];
    const ids = [];
    for (const body of reservations) {
      const res = await request(app)
        .post('/api/dhcp/reservations')
        .send({ ...body, hostname: `printer-${body.subnet_id}` });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    expect(ptrValues().filter((v) => v.startsWith('printer-')).length).toBe(2);

    for (const id of ids) {
      expect((await request(app).delete(`/api/dhcp/reservations/${id}`)).status).toBe(200);
    }
    expect(ptrValues()).not.toContain('fd00:17::20');
    expect(ptrValues()).toContain('10.61.0.20');
    expect(ptrValues().filter((v) => v.startsWith('printer-'))).toEqual([]);
  });
});

describe('reverse zone names (IPV6-28)', () => {
  it('puts a /128 in its /124 zone, so the PTR lands in it', async () => {
    expect(generateReverseNames('2001:db8:1::5/128')).toEqual(
      generateReverseNames('2001:db8:1::/124'),
    );
    await network('2001:db8:1::5/128', { gateway_policy: 'none' });
    const zone = generateReverseNames('2001:db8:1::5/128')[0];
    expect(zone.split('.').length - 2).toBe(31);
    const zoneRow = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(zone);
    expect(zoneRow).toBeTruthy();
  });

  it('refuses a 32-nibble zone name, which is an address and not a zone', async () => {
    const name32 = `${'0.'.repeat(32)}ip6.arpa`;
    const res = await request(app).post('/api/dns/zones').send({ name: name32, type: 'reverse' });
    expect(res.status).toBe(400);
  });
});

describe('PTR names spell one address in their zone (IPV6-29)', () => {
  let v6Zone;
  let v4Zone;
  beforeAll(async () => {
    v6Zone = (
      await request(app)
        .post('/api/dns/zones')
        .send({ name: '8.b.d.0.1.0.0.2.ip6.arpa', type: 'reverse' })
    ).body.id;
    v4Zone = (
      await request(app)
        .post('/api/dns/zones')
        .send({ name: '9.62.10.in-addr.arpa', type: 'reverse' })
    ).body.id;
  });
  const post = (zone, name) =>
    request(app)
      .post(`/api/dns/zones/${zone}/records`)
      .send({ name, type: 'PTR', value: 'host.example.net' });

  it('refuses names that are not an address in the zone', async () => {
    for (const name of ['7', 'ff.1', '0.0']) expect((await post(v6Zone, name)).status).toBe(400);
    for (const name of ['999', '5.5']) expect((await post(v4Zone, name)).status).toBe(400);
  });

  it('accepts a full name, and an upper-case one lowercased', async () => {
    const full = `${'1.'.repeat(23)}A`;
    const res = await post(v6Zone, full);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(full.toLowerCase());
    expect((await post(v4Zone, '5')).status).toBe(201);
  });
});
