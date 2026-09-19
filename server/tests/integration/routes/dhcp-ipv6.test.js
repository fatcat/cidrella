/**
 * DHCPv6 through the DHCP and subnet routes: per-network modes, DUID-keyed
 * reservations, the generated dnsmasq lines, and a lease file with IPv6
 * entries flowing into dynamic_dhcp allocations.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));

const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;
let regenerateScopeConfigs;
let regenerateReservations;
let syncLeases;
let parseLeaseLine;
const subnets = {};

beforeAll(async () => {
  // DATA_DIR is read when utils/dhcp.js loads, so every module that writes
  // dnsmasq files must load after setupTestDb has pointed it at the temp dir.
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  ({ regenerateScopeConfigs, regenerateReservations, syncLeases, parseLeaseLine } =
    await import('../../../src/utils/dhcp.js'));
  const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
  const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
  for (const [key, cidr, mode] of [
    ['stateful', 'fd00:a::/64', 'stateful'],
    ['slaac', 'fd00:b::/64', 'slaac'],
    ['stateless', 'fd00:c::/64', 'stateless'],
  ]) {
    const created = await request(app).post('/api/subnets').send({ cidr });
    const configured = await request(app)
      .post(`/api/subnets/${created.body.id}/configure`)
      .send({
        name: key,
        gateway_policy: 'first',
        create_dhcp_scope: true,
        dhcp_v6_mode: mode,
        domain_name: `${key}.test`,
      });
    expect(configured.status).toBe(200);
    subnets[key] = created.body.id;
  }
});

afterAll(() => cleanupTestDb(tmpDir));

function scopeFor(subnetId) {
  return db.prepare('SELECT * FROM dhcp_scopes WHERE subnet_id = ?').get(subnetId);
}

describe('DHCPv6 scopes', () => {
  it('creates one scope per network with its mode and no router options', () => {
    const stateful = scopeFor(subnets.stateful);
    expect(stateful).toMatchObject({ address_family: 6, v6_mode: 'stateful', gateway: null });
    const pool = db
      .prepare('SELECT start_ip, end_ip FROM dhcp_scope_pools WHERE scope_id = ?')
      .get(stateful.id);
    expect(pool).toEqual({ start_ip: 'fd00:a::1000', end_ip: 'fd00:a::1fff' });
    // Inherited IPv6 defaults only: the search list from the network domain
    // (DNS Servers stays unset because the test host has no address in the
    // prefix) and never the IPv4 mask, router or broadcast codes.
    const options = db
      .prepare(
        'SELECT option_code, value, address_family FROM dhcp_scope_options WHERE scope_id = ?',
      )
      .all(stateful.id);
    expect(options).toEqual([{ option_code: 24, value: 'stateful.test', address_family: 6 }]);
    expect(scopeFor(subnets.slaac)).toMatchObject({ v6_mode: 'slaac' });
    expect(scopeFor(subnets.stateless)).toMatchObject({ v6_mode: 'stateless' });
  });

  it('refuses SLAAC modes off a /64 and routers on IPv6 scopes', async () => {
    const wide = await request(app).post('/api/subnets').send({ cidr: 'fd00:d::/60' });
    const res = await request(app).post(`/api/subnets/${wide.body.id}/configure`).send({
      name: 'wide',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'slaac',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('/64');

    const scope = scopeFor(subnets.stateful);
    const gateway = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ gateway: 'fd00:a::1' });
    expect(gateway.status).toBe(400);
    expect(gateway.body.error).toContain('RA');
    const badMode = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ v6_mode: 'managed' });
    expect(badMode.status).toBe(400);
    const switched = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ v6_mode: 'stateless' });
    expect(switched.status).toBe(200);
    expect(switched.body.v6_mode).toBe('stateless');
    await request(app).put(`/api/dhcp/scopes/${scope.id}`).send({ v6_mode: 'stateful' });
  });

  it('emits the dnsmasq lines for each mode', () => {
    const confDir = path.join(tmpDir, 'dnsmasq', 'conf.d');
    regenerateScopeConfigs(db, { confDir });
    const read = (subnetId) =>
      fs.readFileSync(path.join(confDir, `dhcp-scope-${scopeFor(subnetId).id}.conf`), 'utf8');

    const stateful = read(subnets.stateful);
    const tag = `scope${scopeFor(subnets.stateful).id}`;
    expect(stateful).toContain('enable-ra');
    expect(stateful).toContain(`dhcp-range=set:${tag},fd00:a::1000,fd00:a::1fff,64,`);
    expect(stateful).toContain(`dhcp-option=tag:${tag},option6:domain-search,stateful.test`);
    expect(stateful).not.toContain('option6:dns-server,[fd00:a::1]');
    expect(stateful).not.toMatch(/dhcp-option=tag:scope\d+,3/);

    const slaac = read(subnets.slaac);
    expect(slaac).toContain(
      `dhcp-range=set:scope${scopeFor(subnets.slaac).id},fd00:b::,ra-only,64`,
    );
    expect(slaac).not.toContain('dhcp-option');

    const stateless = read(subnets.stateless);
    expect(stateless).toContain(
      `dhcp-range=set:scope${scopeFor(subnets.stateless).id},fd00:c::,ra-stateless,ra-names,64`,
    );
    expect(stateless).toContain('option6:domain-search,stateless.test');
  });

  it('carves reserved addresses out of a stateful pool and honors explicit DNS servers', async () => {
    const scope = scopeFor(subnets.stateful);
    await request(app)
      .put(`/api/subnets/${subnets.stateful}/ips/fd00:a::1500/allocation`)
      .send({ allocation_state: 'reserved' });
    const res = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ dns_servers: JSON.stringify(['fd00:a::53', '2606:4700:4700::1111']) });
    expect(res.status).toBe(200);
    const confDir = path.join(tmpDir, 'dnsmasq', 'conf.d');
    regenerateScopeConfigs(db, { confDir });
    const conf = fs.readFileSync(path.join(confDir, `dhcp-scope-${scope.id}.conf`), 'utf8');
    expect(conf).toContain(`dhcp-range=set:scope${scope.id},fd00:a::1000,fd00:a::14ff,64,`);
    expect(conf).toContain(`dhcp-range=set:scope${scope.id},fd00:a::1501,fd00:a::1fff,64,`);
    expect(conf).toContain(
      `dhcp-option=tag:scope${scope.id},option6:dns-server,[fd00:a::53],[2606:4700:4700::1111]`,
    );
  });
});

describe('DHCPv6 reservations', () => {
  const duid = '00:01:00:01:2a:3b:4c:5d:aa:bb:cc:dd:ee:01';

  it('binds a DUID to an address and writes the dhcp-host line', async () => {
    const res = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: subnets.stateful,
      ip_address: 'FD00:A::0010',
      duid: duid.toUpperCase(),
      iaid: 42,
      hostname: 'printer6',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ip_address: 'fd00:a::10',
      duid,
      iaid: 42,
      mac_address: null,
      address_family: 6,
    });
    const ip = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = 'fd00:a::10'").get();
    expect(ip).toMatchObject({
      allocation_state: 'static_dhcp',
      dhcp_version: 6,
      dhcp_duid: duid,
      dhcp_iaid: '42',
      hostname: 'printer6',
    });

    const hostsDir = path.join(tmpDir, 'dnsmasq', 'dhcp-hosts.d');
    regenerateReservations(db, { hostsDir });
    const hosts = fs.readFileSync(path.join(hostsDir, 'reservations.hosts'), 'utf8');
    expect(hosts).toContain(`id:${duid},[fd00:a::10],printer6,infinite`);

    const dup = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: subnets.stateful,
      ip_address: 'fd00:a::11',
      duid,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('DUID');
  });

  it('refuses a MAC-only IPv6 reservation, a DUID on IPv4, and reservations under SLAAC', async () => {
    const macOnly = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: subnets.stateful,
      ip_address: 'fd00:a::12',
      mac_address: 'aa:bb:cc:dd:ee:12',
    });
    expect(macOnly.status).toBe(400);
    expect(macOnly.body.error).toContain('duid');

    const v4 = await request(app).post('/api/subnets').send({ cidr: '10.77.0.0/24' });
    await request(app)
      .post(`/api/subnets/${v4.body.id}/configure`)
      .send({ name: 'v4', gateway_policy: 'first' });
    const duidOnV4 = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: v4.body.id,
      ip_address: '10.77.0.20',
      duid,
    });
    expect(duidOnV4.status).toBe(400);

    const underSlaac = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: subnets.slaac,
      ip_address: 'fd00:b::10',
      duid,
    });
    expect(underSlaac.status).toBe(400);
    expect(underSlaac.body.error).toContain('stateful');

    const anycast = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: subnets.stateful,
      ip_address: 'fd00:a::',
      duid: '00:03:00:01:aa:bb:cc:dd:ee:ff',
    });
    expect(anycast.status).toBe(400);
    expect(anycast.body.error).toContain('network address');
  });
});

describe('DHCPv6 leases', () => {
  it('parses dnsmasq lease lines of both families and skips the server DUID header', () => {
    expect(parseLeaseLine('duid 00:01:00:01:aa:bb:cc:dd:ee:ff:00:11')).toBeNull();
    expect(
      parseLeaseLine('1800000000 aa:bb:cc:dd:ee:01 10.0.0.5 laptop 01:aa:bb:cc:dd:ee:01'),
    ).toMatchObject({
      dhcpVersion: 4,
      mac: 'aa:bb:cc:dd:ee:01',
      ip: '10.0.0.5',
      hostname: 'laptop',
      duid: null,
    });
    expect(
      parseLeaseLine('1800000000 12345 fd00:a::1500 laptop 00:01:00:01:CC:DD:EE:FF'),
    ).toMatchObject({
      dhcpVersion: 6,
      mac: null,
      iaid: 12345,
      temporary: false,
      ip: 'fd00:a::1500',
      duid: '00:01:00:01:cc:dd:ee:ff',
    });
    expect(parseLeaseLine('1800000000 T99 fd00:a::1501 * *')).toMatchObject({
      temporary: true,
      iaid: 99,
      hostname: null,
      duid: null,
    });
    expect(parseLeaseLine('')).toBeNull();
    expect(parseLeaseLine('nope 1 2')).toBeNull();
  });

  it('syncs an IPv6 lease into dynamic_dhcp with its DUID, and a stray one is rejected', () => {
    db.prepare("DELETE FROM ip_addresses WHERE ip_address = 'fd00:a::1500'").run();
    const leaseFile = path.join(tmpDir, 'dnsmasq', 'dnsmasq.leases');
    fs.writeFileSync(
      leaseFile,
      [
        'duid 00:01:00:01:aa:bb:cc:dd:ee:ff:00:11',
        '4102444800 12345 fd00:a::1600 laptop6 00:01:00:01:cc:dd:ee:ff:11:22',
        '4102444800 12346 fd00:a::9999 stray 00:01:00:01:cc:dd:ee:ff:33:44',
        '4102444800 12347 fd00:a::1601 anon *',
      ].join('\n') + '\n',
    );
    const result = syncLeases(db, { leaseFile });
    expect(result).toMatchObject({ synced: 1, rejected: 1 });
    const lease = db.prepare("SELECT * FROM dhcp_leases WHERE ip_address = 'fd00:a::1600'").get();
    expect(lease).toMatchObject({
      dhcp_version: 6,
      duid: '00:01:00:01:cc:dd:ee:ff:11:22',
      iaid: 12345,
      mac_address: null,
      hostname: 'laptop6',
    });
    const ip = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = 'fd00:a::1600'").get();
    expect(ip).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      dhcp_version: 6,
      dhcp_duid: '00:01:00:01:cc:dd:ee:ff:11:22',
      dhcp_iaid: '12345',
      address_family: 6,
    });
    expect(
      db
        .prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = 'fd00:a::9999'")
        .get(),
    ).toBeUndefined();
    const record = db
      .prepare("SELECT type, value FROM dns_records WHERE name = 'laptop6' AND type = 'AAAA'")
      .get();
    expect(record).toEqual({ type: 'AAAA', value: 'fd00:a::1600' });

    const addresses = db
      .prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?')
      .get(subnets.stateful);
    return request(app)
      .get(`/api/dhcp/scopes/${addresses.id}/addresses`)
      .then((res) => {
        expect(res.status).toBe(200);
        // The listing covers the pool, so the reservation at ::10 (outside
        // 1000..1fff) is not part of it, the same as an IPv4 scope.
        expect(res.body.map((row) => [row.ip_address, row.dhcp_assignment_type])).toEqual([
          ['fd00:a::1600', 'dynamic'],
        ]);
        expect(res.body[0].duid).toBe('00:01:00:01:cc:dd:ee:ff:11:22');
      });
  });
});

describe('DHCPv6 option defaults and scope options', () => {
  it('serves the IPv6 catalog, defaults and custom range by family', async () => {
    const res = await request(app).get('/api/dhcp/options?family=6');
    expect(res.status).toBe(200);
    expect(res.body.family).toBe(6);
    expect(res.body.customRange).toEqual([1, 65535]);
    expect(res.body.enabledDefaults).toEqual([23, 24]);
    const codes = res.body.catalog.map((o) => o.code);
    expect(codes).toContain(23);
    expect(codes).toContain(56);
    expect(codes).not.toContain(3);
    expect(res.body.catalog.find((o) => o.code === 23).dnsmasqName).toBe('option6:dns-server');

    const v4 = await request(app).get('/api/dhcp/options');
    expect(v4.body.family).toBe(4);
    expect(v4.body.catalog.map((o) => o.code)).toContain(3);
    expect(v4.body.catalog.map((o) => o.code)).not.toContain(56);

    expect((await request(app).get('/api/dhcp/options?family=5')).status).toBe(400);
  });

  it('replaces one family of defaults without touching the other', async () => {
    const v4Before = (await request(app).get('/api/dhcp/options')).body;
    const res = await request(app)
      .put('/api/dhcp/options/defaults')
      .send({
        family: 6,
        options: [
          { code: 56, value: 'fd00:a::123' },
          { code: 32, value: '7200' },
        ],
        enabledDefaults: [23, 24, 56],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      family: 6,
      defaults: { 56: 'fd00:a::123', 32: '7200' },
      enabledDefaults: [23, 24, 56],
    });
    const v4After = (await request(app).get('/api/dhcp/options')).body;
    expect(v4After.defaults).toEqual(v4Before.defaults);
    expect(v4After.enabledDefaults).toEqual(v4Before.enabledDefaults);

    // A code dnsmasq builds itself is refused for IPv6; a v4-sized bound no
    // longer applies.
    const internal = await request(app)
      .put('/api/dhcp/options/defaults')
      .send({ family: 6, options: [{ code: 39, value: 'x' }] });
    expect(internal.status).toBe(400);
    expect(internal.body.error).toMatch(/built by dnsmasq/);
    const wide = await request(app)
      .put('/api/dhcp/options/defaults')
      .send({ family: 6, options: [{ code: 1000, value: 'x' }], enabledDefaults: [23, 24, 56] });
    expect(wide.status).toBe(200);
    // Restore for the tests below.
    await request(app)
      .put('/api/dhcp/options/defaults')
      .send({
        family: 6,
        options: [{ code: 56, value: 'fd00:a::123' }],
        enabledDefaults: [23, 24, 56],
      });
  });

  it('creates and deletes IPv6 custom options in their own namespace', async () => {
    const created = await request(app)
      .post('/api/dhcp/options/custom')
      .send({ code: 200, label: 'Vendor URL', type: 'text', address_family: 6 });
    expect(created.status).toBe(201);
    expect(created.body.address_family).toBe(6);
    // Same code for IPv4 is a different option and still needs 128-254.
    expect(
      (await request(app).post('/api/dhcp/options/custom').send({ code: 200, label: 'v4' })).status,
    ).toBe(201);
    expect(
      (await request(app).post('/api/dhcp/options/custom').send({ code: 300, label: 'v4' })).body
        .error,
    ).toBe('Code must be between 128 and 254');
    const builtIn = await request(app)
      .post('/api/dhcp/options/custom')
      .send({ code: 23, label: 'dns', address_family: 6 });
    expect(builtIn.status).toBe(409);
    const internal = await request(app)
      .post('/api/dhcp/options/custom')
      .send({ code: 1, label: 'client id', address_family: 6 });
    expect(internal.status).toBe(400);

    const v6 = (await request(app).get('/api/dhcp/options?family=6')).body.catalog;
    expect(v6.find((o) => o.code === 200)).toMatchObject({
      custom: true,
      dnsmasqName: 'option6:200',
    });

    expect((await request(app).delete('/api/dhcp/options/custom/200')).status).toBe(200);
    expect(
      (await request(app).get('/api/dhcp/options?family=6')).body.catalog.some(
        (o) => o.code === 200,
      ),
    ).toBe(true);
    expect(
      (await request(app).get('/api/dhcp/options')).body.catalog.some((o) => o.code === 200),
    ).toBe(false);
  });

  it('validates scope options against the IPv6 catalog and writes option6 lines', async () => {
    const scope = scopeFor(subnets.stateful);
    const rejected = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ options: [{ code: 7, value: '1' }] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/built by dnsmasq/);

    const res = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({
        dns_servers: null,
        options: [
          { code: 23, value: 'fd00:a::53' },
          { code: 24, value: 'a.test,b.test' },
          { code: 32, value: '600' },
          { code: 200, value: 'https://vendor.example/cfg' },
          { code: 31, value: 'not an address' },
        ],
      });
    expect(res.status).toBe(200);
    expect(
      db
        .prepare('SELECT DISTINCT address_family FROM dhcp_scope_options WHERE scope_id = ?')
        .all(scope.id),
    ).toEqual([{ address_family: 6 }]);

    const confDir = path.join(tmpDir, 'dnsmasq', 'conf.d');
    regenerateScopeConfigs(db, { confDir });
    const conf = fs.readFileSync(path.join(confDir, `dhcp-scope-${scope.id}.conf`), 'utf8');
    const tag = `tag:scope${scope.id}`;
    expect(conf).toContain(`dhcp-option=${tag},option6:dns-server,[fd00:a::53]`);
    expect(conf).toContain(`dhcp-option=${tag},option6:domain-search,a.test,b.test`);
    expect(conf).toContain(`dhcp-option=${tag},option6:information-refresh-time,600`);
    expect(conf).toContain(`dhcp-option=${tag},option6:200,https://vendor.example/cfg`);
    // The global IPv6 NTP default from the earlier test flows in too.
    expect(conf).toContain(`dhcp-option=${tag},option6:ntp-server,[fd00:a::123]`);
    // An unresolvable address list is dropped, and IPv4 spellings never appear.
    expect(conf).not.toContain('option6:sntp-server');
    expect(conf).not.toContain('option:router');
    expect(conf).not.toContain(`dhcp-option=${tag},23,`);

    // slaac: Router Advertisements only, so no option lines at all.
    const slaac = fs.readFileSync(
      path.join(confDir, `dhcp-scope-${scopeFor(subnets.slaac).id}.conf`),
      'utf8',
    );
    expect(slaac).not.toContain('dhcp-option=');
    expect(
      db
        .prepare('SELECT COUNT(*) AS c FROM dhcp_scope_options WHERE scope_id = ?')
        .get(scopeFor(subnets.slaac).id).c,
    ).toBeGreaterThan(0);
  });
});
