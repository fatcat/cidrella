/**
 * DHCPv6 through the DHCP and subnet routes: per-network modes, DUID-keyed
 * reservations, the generated dnsmasq lines, and a lease file with IPv6
 * entries flowing into dynamic_dhcp allocations.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../../helpers/test-db.js';
import { createMultiRouterApp } from '../../../helpers/test-app.js';
import { DHCP6_DEFAULT_NTP_SERVERS } from '../../../../src/config/defaults.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));

const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;
let regenerateScopeConfigs;
let regenerateReservations;
let parseLeaseLine;
let parseLeaseFile;
let ingestLeases;
const subnets = {};

beforeAll(async () => {
  // DATA_DIR is read when backends/dnsmasq/dhcp.js loads, so every module that writes
  // dnsmasq files must load after setupTestDb has pointed it at the temp dir.
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  ({ regenerateScopeConfigs, regenerateReservations, parseLeaseLine, parseLeaseFile } =
    await import('../../../../src/backends/dnsmasq/dhcp.js'));
  ({ ingestLeases } = await import('../../../../src/services/dhcp-lease-sync.js'));
  const { default: subnetRouter } = await import('../../../../src/routes/subnets.js');
  const { default: dhcpRouter } = await import('../../../../src/routes/dhcp.js');
  const { default: dnsRouter } = await import('../../../../src/routes/dns.js');
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
    { prefix: '/api/dns', router: dnsRouter },
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
    // Inherited IPv6 defaults only: the search list from the network domain,
    // the baked IPv6 NTP pool (DNS Servers stays unset because the test host
    // has no address in the prefix), and never the IPv4 mask, router or
    // broadcast codes.
    const options = db
      .prepare(
        'SELECT option_code, value, address_family FROM dhcp_scope_options WHERE scope_id = ?',
      )
      .all(stateful.id);
    expect(options).toEqual([
      { option_code: 24, value: 'stateful.test', address_family: 6 },
      { option_code: 56, value: DHCP6_DEFAULT_NTP_SERVERS, address_family: 6 },
    ]);
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

  // IPV6-01: dnsmasq refuses a DHCPv6 range on a prefix shorter than /64, and
  // the refused line failed every later configuration write.
  it('offers no DHCPv6 scope on a prefix shorter than /64', async () => {
    for (const cidr of ['fd00:56::/56', 'fd00:48::/48']) {
      const created = await request(app).post('/api/subnets').send({ cidr });
      const preview = await request(app)
        .post('/api/subnets/configuration-preview')
        .send({ cidr, gateway_policy: 'first' });
      expect(preview.body).toMatchObject({ dhcp_v6_modes: [], default_dhcp_pool: null });
      for (const mode of [undefined, 'stateful', 'slaac']) {
        const res = await request(app)
          .post(`/api/subnets/${created.body.id}/configure`)
          .send({ name: cidr, create_dhcp_scope: true, dhcp_v6_mode: mode });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/\/64 or longer|requires a \/64/);
      }
      expect(scopeFor(created.body.id)).toBeUndefined();
    }
  });

  // IPV6-13: the derived pool steps around the gateway, as the IPv4 one does,
  // instead of failing the configure with a 500.
  it('shapes a derived stateful pool around the gateway', async () => {
    const small = await request(app).post('/api/subnets').send({ cidr: 'fd00:7::/120' });
    const first = await request(app).post(`/api/subnets/${small.body.id}/configure`).send({
      name: 'small',
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    expect(first.status).toBe(200);
    const pool = (subnetId) =>
      db
        .prepare('SELECT start_ip, end_ip FROM dhcp_scope_pools WHERE scope_id = ?')
        .get(scopeFor(subnetId).id);
    expect(pool(small.body.id)).toEqual({ start_ip: 'fd00:7::2', end_ip: 'fd00:7::ff' });

    const custom = await request(app).post('/api/subnets').send({ cidr: 'fd00:17::/64' });
    const middle = await request(app).post(`/api/subnets/${custom.body.id}/configure`).send({
      name: 'custom',
      gateway_policy: 'custom',
      gateway_address: 'fd00:17::1500',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    expect(middle.status).toBe(200);
    // The larger side of the default ::1000-::1fff is kept.
    expect(pool(custom.body.id)).toEqual({ start_ip: 'fd00:17::1501', end_ip: 'fd00:17::1fff' });

    const preview = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: 'fd00:27::/120', gateway_policy: 'first' });
    expect(preview.body.default_dhcp_pool).toEqual({
      start_ip: 'fd00:27::2',
      end_ip: 'fd00:27::ff',
    });

    // IPv4 has always stepped around the gateway.
    const v4 = await request(app).post('/api/subnets').send({ cidr: '10.77.7.0/29' });
    const v4Configured = await request(app).post(`/api/subnets/${v4.body.id}/configure`).send({
      name: 'v4 small',
      gateway_policy: 'first',
      create_dhcp_scope: true,
    });
    expect(v4Configured.status).toBe(200);
    expect(pool(v4.body.id)).toEqual({ start_ip: '10.77.7.2', end_ip: '10.77.7.2' });
  });

  // IPV6-09, 02, 18: a slaac or stateless scope's range is the prefix kept for
  // display, not a pool. Only a stateful pool (and every IPv4 pool) is one.
  it('treats only a stateful DHCPv6 scope as an address pool', async () => {
    const zoneId = (name) => db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name).id;
    const aaaa = (zone, name, value) =>
      request(app)
        .post(`/api/dns/zones/${zoneId(zone)}/records`)
        .send({ name, type: 'AAAA', value });
    const status = async (subnetId, ip) =>
      (await request(app).get(`/api/subnets/${subnetId}/ips/${ip}`)).body.ip?.ip_display_status;

    for (const mode of ['slaac', 'stateless']) {
      const prefix = mode === 'slaac' ? 'fd00:b::' : 'fd00:c::';
      // A static AAAA anywhere in the /64.
      const created = await aaaa(`${mode}.test`, 'srv', `${prefix}10`);
      expect(created.status, created.body.error).toBe(201);
      // A free address is available, not "DHCP Scope".
      expect(await status(subnets[mode], `${prefix}20`)).toBe('available');
      // The gateway can move.
      const moved = await request(app)
        .put(`/api/subnets/${subnets[mode]}`)
        .send({ gateway_policy: 'last' });
      expect(moved.status, moved.body.error).toBe(200);
      await request(app).put(`/api/subnets/${subnets[mode]}`).send({ gateway_policy: 'first' });
    }

    // A stateful pool still is one, as every IPv4 pool is.
    const inPool = await aaaa('stateful.test', 'pooled', 'fd00:a::1100');
    expect(inPool.status).toBe(409);
    expect(await status(subnets.stateful, 'fd00:a::1200')).toBe('DHCP Scope');
    expect(await status(subnets.stateful, 'fd00:a::20')).toBe('available');

    const { getNetworkDhcpDiagnostics } =
      await import('../../../../src/utils/network-dhcp-diagnostics.js');
    const slaacScopes = new Set([scopeFor(subnets.slaac).id, scopeFor(subnets.stateless).id]);
    const flagged = getNetworkDhcpDiagnostics(db).issues.filter((issue) =>
      slaacScopes.has(issue.scope_id),
    );
    expect(flagged).toEqual([]);
  });

  // IPV6-10: divide and merge used to drop every DHCPv6 scope.
  it('carries a DHCPv6 scope through a divide and a merge where its mode fits', async () => {
    const pools = (subnetId) =>
      db
        .prepare(
          `SELECT s.v6_mode, p.start_ip, p.end_ip FROM dhcp_scopes s
           JOIN dhcp_scope_pools p ON p.scope_id = s.id WHERE s.subnet_id = ?`,
        )
        .all(subnetId);
    const make = async (cidr, mode) => {
      const created = await request(app).post('/api/subnets').send({ cidr });
      const configured = await request(app)
        .post(`/api/subnets/${created.body.id}/configure`)
        .send({ name: cidr, gateway_policy: 'first', create_dhcp_scope: true, dhcp_v6_mode: mode });
      expect(configured.status, configured.body.error).toBe(200);
      return created.body.id;
    };

    const statefulId = await make('fd00:62::/64', 'stateful');
    const preview = await request(app)
      .post(`/api/subnets/${statefulId}/divide/preview`)
      .send({ new_prefix: 65 });
    expect(preview.status).toBe(200);
    const plannedScopes = preview.body.plan.targets.map((target) => target.scopes.length);
    expect(plannedScopes).toEqual([1, 1]);
    const divided = await request(app)
      .post(`/api/subnets/${statefulId}/divide`)
      .send({ new_prefix: 65, force: true });
    expect(divided.status, divided.body.error).toBe(200);
    const [low, high] = divided.body.children;
    expect(pools(low.id)).toEqual([
      { v6_mode: 'stateful', start_ip: 'fd00:62::1000', end_ip: 'fd00:62::1fff' },
    ]);
    expect(pools(high.id)).toEqual([
      {
        v6_mode: 'stateful',
        start_ip: 'fd00:62::8000:0:0:1000',
        end_ip: 'fd00:62::8000:0:0:1fff',
      },
    ]);

    const merged = await request(app)
      .post('/api/subnets/merge')
      .send({ subnet_ids: [low.id, high.id] });
    expect(merged.status, merged.body.error).toBe(200);
    const whole = db.prepare("SELECT id FROM subnets WHERE cidr = 'fd00:62::/64'").get();
    expect(pools(whole.id)).toEqual([
      { v6_mode: 'stateful', start_ip: 'fd00:62::1000', end_ip: 'fd00:62::1fff' },
    ]);

    // SLAAC needs a /64, so it cannot follow the halves, and the preview says so.
    const slaacId = await make('fd00:63::/64', 'slaac');
    const slaacPreview = await request(app)
      .post(`/api/subnets/${slaacId}/divide/preview`)
      .send({ new_prefix: 65 });
    expect(slaacPreview.body.plan.targets.map((target) => target.scopes.length)).toEqual([0, 0]);
  });

  it('emits the dnsmasq lines for each mode', () => {
    const confDir = path.join(tmpDir, 'dnsmasq', 'conf.d');
    regenerateScopeConfigs(db, { confDir });
    const read = (subnetId) =>
      fs.readFileSync(path.join(confDir, `dhcp-scope-${scopeFor(subnetId).id}.conf`), 'utf8');

    const stateful = read(subnets.stateful);
    const tag = `scope${scopeFor(subnets.stateful).id}`;
    expect(stateful).toContain('enable-ra');
    // IPV6-12: CIDRella's RAs never offer this host as a default router.
    for (const key of ['stateful', 'slaac', 'stateless']) {
      expect(read(subnets[key])).toContain('ra-param=*,0,0');
    }
    expect(stateful).toContain(`dhcp-range=set:${tag},fd00:a::1000,fd00:a::1fff,64,`);
    expect(stateful).toContain(`dhcp-option=tag:${tag},option6:domain-search,stateful.test`);
    expect(stateful).not.toContain('option6:dns-server,[fd00:a::1]');
    expect(stateful).not.toMatch(/dhcp-option=tag:scope\d+,3/);

    // IPV6-15: the lease time is the prefix's advertised valid lifetime.
    const slaacScope = scopeFor(subnets.slaac);
    const slaac = read(subnets.slaac);
    expect(slaac).toMatch(
      new RegExp(
        `^dhcp-range=set:scope${slaacScope.id},fd00:b::,ra-only,64,${slaacScope.lease_time}$`,
        'm',
      ),
    );
    // SLAAC writes only what dnsmasq carries in its Router Advertisements.
    expect(slaac).toContain(
      `dhcp-option=tag:scope${scopeFor(subnets.slaac).id},option6:domain-search,slaac.test`,
    );
    expect(slaac).not.toContain('option6:ntp-server');

    const statelessScope = scopeFor(subnets.stateless);
    const stateless = read(subnets.stateless);
    expect(stateless).toMatch(
      new RegExp(
        `^dhcp-range=set:scope${statelessScope.id},fd00:c::,ra-stateless,ra-names,64,${statelessScope.lease_time}$`,
        'm',
      ),
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
    const result = ingestLeases(db, parseLeaseFile(fs.readFileSync(leaseFile, 'utf8')));
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

  it('records one lease_obtained per DHCPv6 lease, not one per renewal', () => {
    const leaseFile = path.join(tmpDir, 'dnsmasq', 'dnsmasq.leases');
    const sync = (expiry, duid) => {
      fs.writeFileSync(
        leaseFile,
        [
          'duid 00:01:00:01:aa:bb:cc:dd:ee:ff:00:11',
          `${expiry} 22345 fd00:a::1700 renew6 ${duid}`,
        ].join('\n') + '\n',
      );
      ingestLeases(db, parseLeaseFile(fs.readFileSync(leaseFile, 'utf8')));
    };
    const obtained = () =>
      db
        .prepare(
          "SELECT count(*) n FROM ip_events WHERE ip_address = 'fd00:a::1700' AND event_type = 'lease_obtained'",
        )
        .get().n;
    sync(4102444800, '00:01:00:01:cc:dd:ee:ff:17:00');
    sync(4102444900, '00:01:00:01:cc:dd:ee:ff:17:00');
    sync(4102445000, '00:01:00:01:cc:dd:ee:ff:17:00');
    expect(obtained()).toBe(1);
    // Another client on the address is a new lease.
    sync(4102445100, '00:01:00:01:cc:dd:ee:ff:17:01');
    expect(obtained()).toBe(2);
  });
});

describe('DHCPv6 option defaults and scope options', () => {
  it('serves the IPv6 catalog, defaults and custom range by family', async () => {
    const res = await request(app).get('/api/dhcp/options?family=6');
    expect(res.status).toBe(200);
    expect(res.body.family).toBe(6);
    expect(res.body.customRange).toEqual([1, 65535]);
    expect(res.body.enabledDefaults).toEqual([23, 24, 56]);
    const codes = res.body.catalog.map((o) => o.code);
    expect(codes).toContain(23);
    expect(codes).toContain(56);
    expect(codes).not.toContain(3);
    expect(res.body.catalog.find((o) => o.code === 23).dnsmasqName).toBe('option6:dns-server');
    expect(res.body.catalog.find((o) => o.code === 14)).toMatchObject({
      name: 'rapid-commit',
      builtIn: true,
    });

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
    // Rapid Commit is listed, but always on: not a default either.
    const rapid = await request(app)
      .put('/api/dhcp/options/defaults')
      .send({ family: 6, options: [{ code: 14, value: '1' }] });
    expect(rapid.status).toBe(400);
    expect(rapid.body.error).toMatch(/Rapid Commit \(14\) is always on/);
    const rapidEnabled = await request(app)
      .put('/api/dhcp/options/defaults')
      .send({ family: 6, options: [], enabledDefaults: [14] });
    expect(rapidEnabled.status).toBe(400);
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
    const rapid = await request(app)
      .post('/api/dhcp/options/custom')
      .send({ code: 14, label: 'rapid', address_family: 6 });
    expect(rapid.status).toBe(400);
    expect(rapid.body.error).toMatch(/always on/);

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
    const rapid = await request(app)
      .put(`/api/dhcp/scopes/${scope.id}`)
      .send({ options: [{ code: 14, value: '1' }] });
    expect(rapid.status).toBe(400);
    expect(rapid.body.error).toMatch(/always on/);

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

    // slaac: Router Advertisements only, which carry the DNS servers and the
    // search list and nothing else, so NTP and the rest are left out.
    const slaac = fs.readFileSync(
      path.join(confDir, `dhcp-scope-${scopeFor(subnets.slaac).id}.conf`),
      'utf8',
    );
    expect(slaac).not.toContain('option6:ntp-server');
    expect(
      slaac
        .split('\n')
        .filter((line) => line.startsWith('dhcp-option='))
        .every((line) => /option6:(dns-server|domain-search),/.test(line)),
    ).toBe(true);
    expect(
      db
        .prepare('SELECT COUNT(*) AS c FROM dhcp_scope_options WHERE scope_id = ?')
        .get(scopeFor(subnets.slaac).id).c,
    ).toBeGreaterThan(0);
  });
});
