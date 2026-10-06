import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyDhcp',
  ]),
);

const { default: piholeRouter } = await import('../../../src/routes/pihole.js');
const { default: request } = await import('supertest');
const { insertSubnet, configureSubnet } = await import('../../../src/services/subnet-topology.js');
const { parseNetwork } = await import('../../../src/utils/cidr.js');
const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');
const { IPV6_DISABLED_ERROR } = await import('../../../src/utils/ipv6-support.js');

/**
 * The Pi-hole importer with both families (IPV6-39, IPV6-24).
 *
 * A host line names an address of either family and becomes an A or an AAAA
 * record. A DHCP host line is matched to a leaf network of its own family, so
 * an IPv6 network in the estate no longer crashes an IPv4 import half way.
 * IPv6 DHCP host lines are counted, not imported: a Pi-hole dhcp-host names a
 * MAC, and a DHCPv6 reservation binds a DUID.
 */
let tmpDir, app, db, zoneId;

function network(cidr) {
  const id = insertSubnet(db, {
    cidr,
    name: cidr,
    status: 'unallocated',
    depth: 0,
  }).lastInsertRowid;
  const parsed = parseNetwork(cidr);
  configureSubnet(db, db.prepare('SELECT * FROM subnets WHERE id = ?').get(id), parsed, {
    name: cidr,
    gateway: parsed.firstUsable,
    gateway_policy: 'first',
    domain_name: 'mix.lan',
  });
  invalidateSubnetCache();
  return Number(id);
}

beforeEach(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  enableIpv6(db);
  app = createTestApp(piholeRouter, '/api/pihole');
  zoneId = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('mix.lan','forward',1)")
    .run().lastInsertRowid;
});
afterAll(() => cleanupTestDb(tmpDir));

const post = (body) =>
  request(app)
    .post('/api/pihole/import')
    .send({ zoneId, ...body });
const record = (name) =>
  db
    .prepare('SELECT type, value FROM dns_records WHERE zone_id = ? AND name = ?')
    .get(zoneId, name);
const state = (ip) =>
  db.prepare('SELECT allocation_state FROM ip_addresses WHERE ip_address = ?').pluck().get(ip);

describe('DHCP host lines beside an IPv6 network', () => {
  it('imports an IPv4 reservation when an IPv6 leaf network exists', async () => {
    const v4 = network('10.9.0.0/24');
    network('fd00:9::/64');

    const res = await post({
      hosts: [{ hostname: 'nas', ip: '10.9.0.5' }],
      dhcpHosts: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '10.9.0.50', hostname: 'printer' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.dhcp).toMatchObject({ created: 1, failed: 0, noSubnet: 0 });
    expect(
      db.prepare('SELECT subnet_id FROM dhcp_reservations WHERE ip_address = ?').get('10.9.0.50'),
    ).toEqual({ subnet_id: v4 });
  });

  it('counts an IPv6 DHCP host line as not imported rather than failed', async () => {
    network('fd00:9::/64');

    const res = await post({
      dhcpHosts: [{ mac: 'aa:bb:cc:dd:ee:02', ip: 'fd00:9::50', hostname: 'printer6' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.dhcp).toMatchObject({ created: 0, failed: 0, ipv6: 1 });
    expect(db.prepare('SELECT COUNT(*) FROM dhcp_reservations').pluck().get()).toBe(0);
  });

  it('parses the bracketed IPv6 address of a dnsmasq dhcp-host', async () => {
    const toml = [
      '[dhcp]',
      'hosts = ["aa:bb:cc:dd:ee:03,[fd00:9::51],printer6", "aa:bb:cc:dd:ee:04,10.9.0.51,printer4"]',
    ].join('\n');
    const res = await request(app)
      .post('/api/pihole/parse')
      .set('Content-Type', 'text/plain')
      .send(toml);
    expect(res.status).toBe(200);
    expect(res.body.dhcpHosts.map((d) => d.ip)).toEqual(['fd00:9::51', '10.9.0.51']);
  });
});

describe('host lines of either family', () => {
  it('imports an IPv6 host line as an AAAA record that claims its address', async () => {
    network('10.9.0.0/24');
    network('fd00:9::/64');

    const res = await post({
      hosts: [
        { hostname: 'nas', ip: '10.9.0.5' },
        { hostname: 'nas6', ip: 'FD00:9:0:0::5' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.a.created).toBe(1);
    expect(res.body.results.aaaa.created).toBe(1);
    expect(record('nas')).toEqual({ type: 'A', value: '10.9.0.5' });
    expect(record('nas6')).toEqual({ type: 'AAAA', value: 'fd00:9::5' });
    expect(state('10.9.0.5')).toBe('static_dns');
    expect(state('fd00:9::5')).toBe('static_dns');
  });

  it('accepts a CNAME to an AAAA host, in the same file or already in the zone', async () => {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'old6', 'AAAA', 'fd00:9::7', 1)",
    ).run(zoneId);

    const res = await post({
      hosts: [{ hostname: 'new6', ip: 'fd00:9::8' }],
      cnames: [
        { alias: 'www6', target: 'new6.mix.lan' },
        { alias: 'legacy6', target: 'old6.mix.lan' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.cname.created).toBe(2);
    expect(record('legacy6')).toEqual({ type: 'CNAME', value: 'old6.mix.lan' });
  });

  it('rejects two names for one IPv6 address, as for IPv4', async () => {
    const res = await post({
      hosts: [
        { hostname: 'one', ip: 'fd00:9::9' },
        { hostname: 'two', ip: 'fd00:9:0::9' },
        { hostname: 'three', ip: '10.9.0.9' },
        { hostname: 'four', ip: '10.9.0.9' },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.problems.map((p) => [p.type, p.name]).sort()).toEqual([
      ['A', 'four'],
      ['A', 'three'],
      ['AAAA', 'one'],
      ['AAAA', 'two'],
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM dns_records').pluck().get()).toBe(0);
  });

  it('refuses an IPv6 host line, and imports nothing, while IPv6 is switched off', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'ipv6_enabled'").run();

    const res = await post({
      hosts: [
        { hostname: 'nas', ip: '10.9.0.5' },
        { hostname: 'nas6', ip: 'fd00:9::5' },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual([
      { type: 'AAAA', name: 'nas6', value: 'fd00:9::5', reason: IPV6_DISABLED_ERROR },
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM dns_records').pluck().get()).toBe(0);
  });
});
