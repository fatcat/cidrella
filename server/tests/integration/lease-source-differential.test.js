/**
 * The same leases from either DHCP backend give the same addresses, names
 * and records (docs/ARCHITECTURE.md, the BackendLease paragraph). dnsmasq
 * reports a DHCP Reservation's lease as 'infinite'; Kea reports its real
 * expiry. Two identical networks per family take the two shapes through
 * the real routes and lease ingestion, and every projection must agree.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../helpers/test-db.js';
import { createMultiRouterApp } from '../helpers/test-app.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));
vi.mock('../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../helpers/fake-backends.js')).stubBackendApply(await importOriginal()),
);

const { default: request } = await import('supertest');

const FUTURE = '2100-01-01T00:00:00.000Z';
// Per family: the network for dnsmasq's shape and Kea's, and how to name a host in it.
const WORLDS = {
  4: {
    dnsmasq: { cidr: '10.0.1.0/24', host: (n) => `10.0.1.${n}` },
    kea: { cidr: '10.0.2.0/24', host: (n) => `10.0.2.${n}` },
  },
  6: {
    dnsmasq: { cidr: 'fd00:1::/64', host: (n) => `fd00:1::${n}` },
    kea: { cidr: 'fd00:2::/64', host: (n) => `fd00:2::${n}` },
  },
};
const clientOf = (family, world, n) =>
  family === 4
    ? { mac: `aa:bb:cc:0${world === 'kea' ? 2 : 1}:00:${n}`, duid: null }
    : { mac: null, duid: `00:01:00:01:aa:bb:cc:dd:0${world === 'kea' ? 2 : 1}:00:00:${n}` };

let tmpDir;
let db;
let app;
let ingestLeases;
let getCanonicalSubnetIpRow;
let resolveCanonicalHostname;
const subnetIds = {};

beforeAll(async () => {
  const setup = await setupTestDb();
  ({ db, tmpDir } = setup);
  enableIpv6(db);
  ({ ingestLeases } = await import('../../src/services/dhcp-lease-sync.js'));
  ({ getCanonicalSubnetIpRow } = await import('../../src/models/subnet-ip-read.js'));
  ({ resolveCanonicalHostname } = await import('../../src/utils/ip-sync.js'));
  const { default: subnetRouter } = await import('../../src/routes/subnets.js');
  const { default: dhcpRouter } = await import('../../src/routes/dhcp.js');
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);

  const leases = [];
  for (const family of [4, 6]) {
    for (const world of ['dnsmasq', 'kea']) {
      const { cidr, host } = WORLDS[family][world];
      const created = await request(app).post('/api/subnets').send({ cidr });
      expect(created.status).toBe(201);
      const configured = await request(app)
        .post(`/api/subnets/${created.body.id}/configure`)
        .send({
          name: `${world}${family}`,
          gateway_policy: 'first',
          create_dhcp_scope: true,
          ...(family === 6 ? { dhcp_v6_mode: 'stateful' } : {}),
          domain_name: `${world}${family}.test`,
        });
      expect(configured.status).toBe(200);
      subnetIds[`${family}${world}`] = created.body.id;

      // A reservation at host 10, and a dynamic client in the pool.
      const reserved = clientOf(family, world, 10);
      const reservation = await request(app)
        .post('/api/dhcp/reservations')
        .send({
          subnet_id: created.body.id,
          ip_address: host(10),
          hostname: 'printer',
          ...(family === 4 ? { mac_address: reserved.mac } : { duid: reserved.duid, iaid: 1 }),
        });
      expect(reservation.status, JSON.stringify(reservation.body)).toBe(201);
      const scope = db
        .prepare(
          `SELECT p.start_ip FROM dhcp_scope_pools p JOIN dhcp_scopes s ON s.id = p.scope_id
           WHERE s.subnet_id = ? ORDER BY p.id LIMIT 1`,
        )
        .get(created.body.id);
      const dynamicIp = scope.start_ip;
      const dynamic = clientOf(family, world, 30);
      const lease = (ip, client, hostname, expiresAt, iaid) => ({
        ip,
        mac: client.mac,
        hostname,
        clientId: client.duid,
        expiresAt,
        dhcpVersion: family,
        duid: client.duid,
        iaid: family === 6 ? iaid : null,
      });
      leases.push(
        // The one difference: how each backend reports the reserved lease.
        lease(host(10), reserved, 'printer', world === 'kea' ? FUTURE : 'infinite', 1),
        lease(dynamicIp, dynamic, 'laptop', FUTURE, 2),
      );
      subnetIds[`${family}${world}:dynamic`] = dynamicIp;
    }
  }
  ingestLeases(db, leases);
});

afterAll(() => cleanupTestDb(tmpDir));

const VIEW_FIELDS = [
  'allocation_state',
  'address_type',
  'ip_display_status',
  'hostname',
  'dhcp_lease_state',
  'has_dhcp_reservation',
  'dhcp_version',
];

function projection(family, world, ip) {
  const subnetId = subnetIds[`${family}${world}`];
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  const row = getCanonicalSubnetIpRow(db, subnet, ip);
  return {
    view: Object.fromEntries(VIEW_FIELDS.map((f) => [f, row[f]])),
    canonical: resolveCanonicalHostname(db, subnetId, ip),
  };
}

function records(family, world) {
  const zone = `${world}${family}.test`;
  return db
    .prepare(
      `SELECT r.name, r.type, r.source FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id
       WHERE z.name = ? ORDER BY r.name, r.type`,
    )
    .all(zone);
}

describe('lease source differential', () => {
  for (const family of [4, 6]) {
    it(`gives the same IPv${family} reserved and dynamic addresses from either backend`, () => {
      const { dnsmasq, kea } = WORLDS[family];
      const reservedA = projection(family, 'dnsmasq', dnsmasq.host(10));
      const reservedB = projection(family, 'kea', kea.host(10));
      expect(reservedA.view).toMatchObject({
        allocation_state: 'static_dhcp',
        hostname: 'printer',
      });
      expect(reservedB).toEqual(reservedA);

      const dynamicA = projection(family, 'dnsmasq', subnetIds[`${family}dnsmasq:dynamic`]);
      const dynamicB = projection(family, 'kea', subnetIds[`${family}kea:dynamic`]);
      expect(dynamicA.view).toMatchObject({ allocation_state: 'dynamic_dhcp', hostname: 'laptop' });
      expect(dynamicB).toEqual(dynamicA);
    });

    it(`writes the same IPv${family} forward records from either backend`, () => {
      const a = records(family, 'dnsmasq');
      expect(a.map((r) => r.name)).toEqual(expect.arrayContaining(['printer', 'laptop']));
      expect(records(family, 'kea')).toEqual(a);
    });
  }
});
