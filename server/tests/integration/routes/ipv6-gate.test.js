/**
 * The global IPv6 switch. Off by default: every route that would create an
 * IPv6 object answers with one 400, IPv4 keeps working, IPv6 rows created
 * while the switch was on stay readable and deletable after it is turned
 * off, and the host's IPv6 addresses disappear from the interface list.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));
// The interfaces route rebinds the resolver and the blocklist route reloads
// it; neither needs a live proxy here.
vi.mock('../../../src/utils/dns-proxy.js', () => ({
  rebindProxy: vi.fn(),
  loadBlocklist: vi.fn(),
  loadWhitelist: vi.fn(),
}));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { default: request } = await import('supertest');

const DISABLED = 'IPv6 support is disabled. Enable it under Settings > General > Interfaces.';

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  const [subnets, dns, dhcp, blocklists, interfaces, features] = await Promise.all([
    import('../../../src/routes/subnets.js'),
    import('../../../src/routes/dns.js'),
    import('../../../src/routes/dhcp.js'),
    import('../../../src/routes/blocklists.js'),
    import('../../../src/routes/interfaces.js'),
    import('../../../src/routes/features.js'),
  ]);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnets.default },
    { prefix: '/api/dns', router: dns.default },
    { prefix: '/api/dhcp', router: dhcp.default },
    { prefix: '/api/blocklists', router: blocklists.default },
    { prefix: '/api/interfaces', router: interfaces.default },
    { prefix: '/api/features', router: features.default },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

const setSwitch = (on) => request(app).put('/api/interfaces/config').send({ ipv6_enabled: on });

describe('default state', () => {
  it('is off for a fresh database, and the generic settings row says so', async () => {
    expect((await request(app).get('/api/features')).body).toEqual({ ipv6: false });
    expect((await request(app).get('/api/interfaces/config')).body.ipv6_enabled).toBe(false);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ipv6_enabled'").get().value).toBe(
      'false',
    );
  });

  it('refuses an IPv6 network and still creates an IPv4 one', async () => {
    const v6 = await request(app).post('/api/subnets').send({ cidr: 'fd00:9::/64' });
    expect(v6.status).toBe(400);
    expect(v6.body.error).toBe(DISABLED);
    const v4 = await request(app).post('/api/subnets').send({ cidr: '10.9.0.0/24' });
    expect(v4.status).toBe(201);
  });

  it('refuses an ip6.arpa zone, a v6 forwarder, a v6 sinkhole, and a v6 encrypted upstream', async () => {
    const zone = await request(app)
      .post('/api/dns/zones')
      .send({ name: '0.0.0.0.0.0.0.0.0.0.0.0.0.0.d.f.ip6.arpa', type: 'reverse' });
    expect(zone.status).toBe(400);
    expect(zone.body.error).toBe(DISABLED);

    const fwd = await request(app)
      .put('/api/dns/forwarders')
      .send({ servers: ['1.1.1.1', '2606:4700:4700::1111'] });
    expect(fwd.status).toBe(400);
    expect(fwd.body.error).toBe(DISABLED);
    expect(
      (
        await request(app)
          .put('/api/dns/forwarders')
          .send({ servers: ['1.1.1.1'] })
      ).status,
    ).toBe(200);

    const sink = await request(app)
      .put('/api/blocklists/settings')
      .send({ blocklist_redirect_ip6: 'fd00::dead' });
    expect(sink.status).toBe(400);
    expect(sink.body.error).toBe(DISABLED);
    const cleared = await request(app)
      .put('/api/blocklists/settings')
      .send({ blocklist_redirect_ip6: '' });
    expect(cleared.body).toEqual({ ok: true });

    const enc = await request(app)
      .put('/api/dns/encryption')
      .send({
        mode: 'tls',
        upstreams: [{ hostname: 'dns.quad9.net', addresses: ['2620:fe::fe'] }],
      });
    expect(enc.status).toBe(400);
    expect(enc.body.error).toBe(DISABLED);
  });

  it('rejects a non-boolean switch value', async () => {
    const res = await request(app).put('/api/interfaces/config').send({ ipv6_enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ipv6_enabled must be a boolean');
  });
});

describe('switching on, creating IPv6 objects, switching off', () => {
  let netId;
  let scopeId;
  let zoneId;

  it('turns on through the interfaces config and is visible to every reader', async () => {
    const res = await setSwitch(true);
    expect(res.status).toBe(200);
    expect(res.body.ipv6_enabled).toBe(true);
    expect((await request(app).get('/api/features')).body).toEqual({ ipv6: true });
    expect((await request(app).get('/api/interfaces/config')).body.ipv6_enabled).toBe(true);
    const audit = db
      .prepare(
        "SELECT details FROM audit_log WHERE action = 'interface_config_updated' ORDER BY id DESC",
      )
      .get();
    expect(JSON.parse(audit.details).ipv6_enabled).toBe(true);
  });

  it('creates and configures an IPv6 network with a stateful scope and AAAA record', async () => {
    const created = await request(app).post('/api/subnets').send({ cidr: 'fd00:9::/64' });
    expect(created.status).toBe(201);
    netId = created.body.id;
    const configured = await request(app).post(`/api/subnets/${netId}/configure`).send({
      name: 'lab6',
      gateway_policy: 'first',
      create_reverse_dns: true,
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
      domain_name: 'lab6.test',
    });
    expect(configured.status).toBe(200);
    scopeId = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(netId).id;
    zoneId = db.prepare("SELECT id FROM dns_zones WHERE name = 'lab6.test'").get().id;
    const aaaa = await request(app)
      .post(`/api/dns/zones/${zoneId}/records`)
      .send({ name: 'host1', type: 'AAAA', value: 'fd00:9::10' });
    expect(aaaa.status).toBe(201);
    const res6 = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: netId,
      ip_address: 'fd00:9::20',
      duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11',
      hostname: 'printer6',
    });
    expect(res6.status).toBe(201);
  });

  it('turns off again and refuses new IPv6 configuration while keeping what exists', async () => {
    expect((await setSwitch(false)).body.ipv6_enabled).toBe(false);

    // Readable.
    const detail = await request(app).get(`/api/subnets/${netId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.cidr).toBe('fd00:9::/64');
    const ips = await request(app).get(`/api/subnets/${netId}/ips`);
    expect(ips.status).toBe(200);
    expect(ips.body.sparse).toBe(true);

    // Not (re)configurable.
    const configure = await request(app)
      .post(`/api/subnets/${netId}/configure`)
      .send({ name: 'lab6', gateway_policy: 'first' });
    expect(configure.status).toBe(400);
    expect(configure.body.error).toBe(DISABLED);
    const aaaa = await request(app)
      .post(`/api/dns/zones/${zoneId}/records`)
      .send({ name: 'host2', type: 'AAAA', value: 'fd00:9::11' });
    expect(aaaa.status).toBe(400);
    expect(aaaa.body.error).toBe(DISABLED);
    const scopeMode = await request(app)
      .put(`/api/dhcp/scopes/${scopeId}`)
      .send({ v6_mode: 'slaac' });
    expect(scopeMode.status).toBe(400);
    expect(scopeMode.body.error).toBe(DISABLED);
    const reservation = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: netId,
      ip_address: 'fd00:9::21',
      duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:12',
    });
    expect(reservation.status).toBe(400);
    expect(reservation.body.error).toBe(DISABLED);

    // Still operable for non-IPv6 fields.
    const describe6 = await request(app)
      .put(`/api/dhcp/scopes/${scopeId}`)
      .send({ description: 'kept', enabled: false });
    expect(describe6.status).toBe(200);
    const a4 = await request(app)
      .post(`/api/dns/zones/${zoneId}/records`)
      .send({ name: 'host4', type: 'A', value: '10.9.0.40' });
    expect(a4.status).toBe(201);

    // Deletable: the first delete of an allocated network deallocates it,
    // the second removes the row, both with IPv6 off. Deallocation refuses
    // while the reservation from the previous step exists, so clear it first;
    // the reservation route stays deletable with IPv6 off.
    const blocked = await request(app).delete(`/api/subnets/${netId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      reason_code: 'reservations_present',
      reservation_count: 1,
    });
    const reservationId = db
      .prepare('SELECT id FROM dhcp_reservations WHERE subnet_id = ?')
      .get(netId).id;
    expect((await request(app).delete(`/api/dhcp/reservations/${reservationId}`)).status).toBe(200);
    const dealloc = await request(app).delete(`/api/subnets/${netId}`);
    expect(dealloc.status).toBe(200);
    const remaining = db.prepare('SELECT status FROM subnets WHERE id = ?').get(netId);
    if (remaining) {
      expect(remaining.status).toBe('unallocated');
      expect((await request(app).delete(`/api/subnets/${netId}`)).status).toBe(200);
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM subnets WHERE id = ?').get(netId).c).toBe(0);
  });
});

describe('GET /api/interfaces', () => {
  const IFACES = {
    eth0: [
      { family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', internal: false },
      {
        family: 'IPv6',
        address: 'fd00:a::5',
        netmask: 'ffff:ffff:ffff:ffff::',
        internal: false,
        scopeid: 0,
      },
      {
        family: 'IPv6',
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        internal: false,
        scopeid: 2,
      },
    ],
  };
  let spies = [];
  beforeAll(() => {
    // Only the sysfs reads are faked; dnsmasq's own directory scans must
    // keep working for the switch to apply.
    const readdir = fs.readdirSync;
    const exists = fs.existsSync;
    spies = [
      vi.spyOn(os, 'networkInterfaces').mockReturnValue(IFACES),
      vi
        .spyOn(fs, 'readdirSync')
        .mockImplementation((target, ...rest) =>
          target === '/sys/class/net' ? ['eth0'] : readdir(target, ...rest),
        ),
      vi
        .spyOn(fs, 'existsSync')
        .mockImplementation((target) =>
          target === '/sys/class/net/eth0/address' ? true : exists(target),
        ),
    ];
  });
  afterAll(() => spies.forEach((s) => s.mockRestore()));

  it('lists only IPv4 addresses while IPv6 is off, and both families when on', async () => {
    await setSwitch(false);
    const off = await request(app).get('/api/interfaces');
    expect(off.status).toBe(200);
    const eth0 = off.body.find((i) => i.name === 'eth0');
    expect(eth0.addresses.map((a) => a.address)).toEqual(['10.0.0.5']);

    const switched = await setSwitch(true);
    expect(switched.body).toMatchObject({ ipv6_enabled: true });
    const on = await request(app).get('/api/interfaces');
    expect(on.body.find((i) => i.name === 'eth0').addresses.map((a) => a.family)).toEqual([
      4, 6, 6,
    ]);
    await setSwitch(false);
  });
});
