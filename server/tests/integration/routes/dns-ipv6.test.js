/**
 * AAAA records and ip6.arpa reverse DNS through the DNS routes, driving the
 * same static DNS lifecycle as A records on an IPv6 network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
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
vi.mock('../../../src/utils/encrypted-forwarder.js', () => ({
  applyEncryptedForwarder: vi.fn(),
  getEncryptedForwarderStatus: vi.fn(() => ({ running: false })),
}));

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;
let netId;
let forwardZoneId;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dns', router: dnsRouter },
  ]);
  const created = await request(app).post('/api/subnets').send({ cidr: 'fd00:6::/64' });
  netId = created.body.id;
  const configured = await request(app).post(`/api/subnets/${netId}/configure`).send({
    name: 'lab6',
    gateway_policy: 'first',
    create_reverse_dns: true,
    domain_name: 'lab6.test',
  });
  expect(configured.status).toBe(200);
  forwardZoneId = db.prepare("SELECT id FROM dns_zones WHERE name = 'lab6.test'").get().id;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('IPv6 DNS', () => {
  it('created one ip6.arpa reverse zone at the nibble boundary of the /64', () => {
    const zones = db
      .prepare("SELECT name FROM dns_zones WHERE type = 'reverse' ORDER BY name")
      .all()
      .map((zone) => zone.name);
    expect(zones).toEqual(['0.0.0.0.0.0.0.0.6.0.0.0.0.0.d.f.ip6.arpa']);
    // No placeholder walk: only the topology addresses have PTR rows so far.
    const ptrs = db
      .prepare("SELECT name, value, source FROM dns_records WHERE type = 'PTR' ORDER BY name")
      .all();
    expect(ptrs.map((ptr) => ptr.value).sort()).toEqual(['fd00:6::', 'fd00:6::1']);
    expect(ptrs.every((ptr) => ptr.source === 'placeholder')).toBe(true);
  });

  it('accepts an AAAA record in canonical spelling and allocates the address', async () => {
    const res = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'host1', type: 'AAAA', value: 'FD00:0006:0000:0000::10' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe('fd00:6::10');

    const row = db
      .prepare("SELECT allocation_state, hostname, address_family FROM ip_addresses WHERE ip_address = 'fd00:6::10'")
      .get();
    expect(row).toMatchObject({ allocation_state: 'static_dns', hostname: 'host1.lab6.test', address_family: 6 });

    const ptr = db
      .prepare("SELECT name, value, source FROM dns_records WHERE type = 'PTR' AND value = 'host1.lab6.test'")
      .get();
    expect(ptr).toMatchObject({ name: '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', source: 'dns' });

    const dup = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'host1', type: 'AAAA', value: 'fd00:6::10' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('Duplicate AAAA');

    const other = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'host1-alias', type: 'AAAA', value: 'fd00:6::10' });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain('CNAME');
  });

  it('rejects malformed and protected IPv6 values', async () => {
    const bad = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'bad', type: 'AAAA', value: 'fd00:6::zz' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid IPv6 address');
    const v4 = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'bad', type: 'AAAA', value: '10.0.0.1' });
    expect(v4.status).toBe(400);
    const anycast = await request(app)
      .post(`/api/dns/zones/${forwardZoneId}/records`)
      .send({ name: 'router-anycast', type: 'AAAA', value: 'fd00:6::' });
    expect(anycast.status).toBe(409);
  });

  it('moves the allocation when the AAAA value changes and releases it on delete', async () => {
    const record = db
      .prepare("SELECT id FROM dns_records WHERE type = 'AAAA' AND value = 'fd00:6::10'")
      .get();
    const moved = await request(app)
      .put(`/api/dns/zones/${forwardZoneId}/records/${record.id}`)
      .send({ value: 'fd00:6::11' });
    expect(moved.status).toBe(200);
    expect(moved.body.value).toBe('fd00:6::11');
    const states = db
      .prepare("SELECT ip_address, allocation_state FROM ip_addresses WHERE ip_address IN ('fd00:6::10', 'fd00:6::11') ORDER BY ip_address")
      .all();
    expect(states).toEqual([
      { ip_address: 'fd00:6::10', allocation_state: 'unassigned' },
      { ip_address: 'fd00:6::11', allocation_state: 'static_dns' },
    ]);

    const removed = await request(app).delete(`/api/dns/zones/${forwardZoneId}/records/${record.id}`);
    expect(removed.status).toBe(200);
    expect(
      db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = 'fd00:6::11'").get()
        .allocation_state,
    ).toBe('unassigned');
    expect(
      db.prepare("SELECT value FROM dns_records WHERE type = 'PTR' AND name = '1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0'").get()
        ?.value,
    ).toBe('fd00:6::11');
  });

  it('accepts manual ip6.arpa zones and nibble PTR names, and refuses junk', async () => {
    const zone = await request(app)
      .post('/api/dns/zones')
      .send({ name: '8.b.d.0.1.0.0.2.ip6.arpa', type: 'reverse' });
    expect(zone.status).toBe(201);
    const ptr = await request(app)
      .post(`/api/dns/zones/${zone.body.id}/records`)
      .send({ name: '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0', type: 'PTR', value: 'doc.example.net' });
    expect(ptr.status).toBe(201);
    const junk = await request(app)
      .post(`/api/dns/zones/${zone.body.id}/records`)
      .send({ name: 'g.1', type: 'PTR', value: 'doc.example.net' });
    expect(junk.status).toBe(400);
    const badZone = await request(app)
      .post('/api/dns/zones')
      .send({ name: '8.b.d.0.1.0.0.2.ip6.arpa\nserver=1.1.1.1', type: 'reverse' });
    expect(badZone.status).toBe(400);
  });

  it('accepts IPv6 forwarders and encrypted upstreams, but not scoped or reserved ones', async () => {
    const res = await request(app)
      .put('/api/dns/forwarders')
      .send({ servers: ['2606:4700:4700::1111', '1.1.1.1', '2001:4860:4860:0:0:0:0:8888'] });
    expect(res.status).toBe(200);
    const stored = typeof res.body.servers === 'string' ? JSON.parse(res.body.servers) : res.body.servers;
    expect(stored).toEqual(['2606:4700:4700::1111', '1.1.1.1', '2001:4860:4860::8888']);

    const scoped = await request(app).put('/api/dns/forwarders').send({ servers: ['fe80::1%eth0'] });
    expect(scoped.status).toBe(400);

    const enc = await request(app)
      .put('/api/dns/encryption')
      .send({
        mode: 'tls',
        upstreams: [{ hostname: 'one.one.one.one', addresses: ['2606:4700:4700::1111'] }],
      });
    expect(enc.status).toBe(200);
    const ula = await request(app)
      .put('/api/dns/encryption')
      .send({ mode: 'tls', upstreams: [{ hostname: 'x', addresses: ['fd00::1'] }] });
    expect(ula.status).toBe(400);
    expect(ula.body.error).toContain('reserved');
  });
});
