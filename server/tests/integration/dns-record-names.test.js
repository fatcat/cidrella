/**
 * DNS-NAME-01: one naming rule through every entry point (docs/ARCHITECTURE.md,
 * Canonical IP Model). A name ending in '.' is absolute; every other name is
 * relative to its zone, dotted or not. The records API, the Pi-hole import and
 * DHCP lease ingestion must store and read names by that rule, and the SQL
 * behind the CNAME target check must agree with fqdnForRecordName.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, enableIpv6, setupTestDb } from '../helpers/test-db.js';
import { createMultiRouterApp } from '../helpers/test-app.js';

vi.mock('../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../helpers/fake-backends.js')).stubBackendApply(await importOriginal()),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { default: dnsRouter } = await import('../../src/routes/dns.js');
const { default: piholeRouter } = await import('../../src/routes/pihole.js');
const { default: request } = await import('supertest');
const { fqdnForRecordName } = await import('../../src/models/dns-record.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');

const ZONE = 'names.test';
const FAR = '2100-01-01T00:00:00.000Z';

let db;
let tmpDir;
let app;
let zoneId;
let ingestLeases;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  ({ ingestLeases } = await import('../../src/services/dhcp-lease-sync.js'));
  app = createMultiRouterApp([
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/pihole', router: piholeRouter },
  ]);

  const subnetId = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, status, domain_name)
       VALUES ('10.70.0.0/24', 'Names', '10.70.0.0', '10.70.0.255', 24, 256, 'allocated', ?)`,
    )
    .run(ZONE).lastInsertRowid;
  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db
    .prepare(
      `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
       VALUES (?, ?, '10.70.0.100', '10.70.0.200')`,
    )
    .run(subnetId, rangeTypeId).lastInsertRowid;
  const scopeId = db
    .prepare("INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time) VALUES (?, ?, '1h')")
    .run(rangeId, subnetId).lastInsertRowid;
  db.prepare(
    `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
     VALUES (?, ?, '10.70.0.100', '10.70.0.200')`,
  ).run(scopeId, rangeId);
  zoneId = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES (?, 'forward', 1)")
    .run(ZONE).lastInsertRowid;
  invalidateSubnetCache();
});

afterAll(() => cleanupTestDb(tmpDir));

const stored = (type, value) =>
  db
    .prepare('SELECT name FROM dns_records WHERE zone_id = ? AND type = ? AND value = ?')
    .get(zoneId, type, value)?.name;
const fqdn = (type, value) => fqdnForRecordName(stored(type, value), ZONE);
const addRecord = (body) => request(app).post(`/api/dns/zones/${zoneId}/records`).send(body);

describe('records API', () => {
  it('keeps a dotted name without the dot relative, for A and AAAA', async () => {
    expect((await addRecord({ name: 'WWW.Sub', type: 'A', value: '10.70.0.10' })).status).toBe(201);
    expect((await addRecord({ name: 'www6.sub', type: 'AAAA', value: 'fd00:70::10' })).status).toBe(
      201,
    );
    expect(stored('A', '10.70.0.10')).toBe('www.sub');
    expect(fqdn('A', '10.70.0.10')).toBe(`www.sub.${ZONE}`);
    expect(fqdn('AAAA', 'fd00:70::10')).toBe(`www6.sub.${ZONE}`);

    const list = await request(app).get(`/api/dns/zones/${zoneId}/records`);
    expect(list.body.find((r) => r.value === '10.70.0.10').record_fqdn).toBe(`www.sub.${ZONE}`);
  });

  it('takes a trailing dot as absolute, and an absolute name in the zone as relative', async () => {
    await addRecord({ name: 'nas.home.lan.', type: 'A', value: '10.70.0.11' });
    await addRecord({ name: 'nas6.home.lan.', type: 'AAAA', value: 'fd00:70::11' });
    await addRecord({ name: `host.${ZONE}.`, type: 'A', value: '10.70.0.12' });
    expect(stored('A', '10.70.0.11')).toBe('nas.home.lan.');
    expect(fqdn('A', '10.70.0.11')).toBe('nas.home.lan');
    expect(fqdn('AAAA', 'fd00:70::11')).toBe('nas6.home.lan');
    expect(stored('A', '10.70.0.12')).toBe('host');
  });

  it('finds a CNAME target by the same rule the records are served by', async () => {
    // www.sub is served as www.sub.names.test, so a CNAME may point at it.
    const ok = await addRecord({ name: 'alias', type: 'CNAME', value: `www.sub.${ZONE}` });
    expect(ok.status).toBe(201);
    // Nothing is served as nas.home.lan.names.test: the A record is absolute.
    const missing = await addRecord({
      name: 'alias2',
      type: 'CNAME',
      value: `nas.home.lan.${ZONE}`,
    });
    expect(missing.status).toBe(400);
  });
});

describe('Pi-hole import', () => {
  it('stores a full name outside the zone as absolute and one inside as relative', async () => {
    const res = await request(app)
      .post('/api/pihole/import')
      .send({
        zoneId,
        hosts: [
          { hostname: 'nas2.home.lan', ip: '10.70.0.20' },
          { hostname: `printer.${ZONE}`, ip: '10.70.0.21' },
          { hostname: 'nas7.home.lan', ip: 'fd00:70::20' },
        ],
      });
    expect(res.status).toBe(200);
    expect(stored('A', '10.70.0.20')).toBe('nas2.home.lan.');
    expect(fqdn('A', '10.70.0.20')).toBe('nas2.home.lan');
    expect(stored('A', '10.70.0.21')).toBe('printer');
    expect(fqdn('AAAA', 'fd00:70::20')).toBe('nas7.home.lan');
  });
});

describe('DHCP lease ingestion', () => {
  it('puts the lease name under the zone; the address keeps the short name (ADR 005)', () => {
    ingestLeases(db, [
      {
        ip: '10.70.0.150',
        mac: 'aa:bb:cc:70:00:01',
        hostname: 'laptop',
        clientId: null,
        expiresAt: FAR,
        dhcpVersion: 4,
        duid: null,
        iaid: null,
      },
    ]);
    expect(stored('A', '10.70.0.150')).toBe('laptop');
    expect(fqdn('A', '10.70.0.150')).toBe(`laptop.${ZONE}`);
    expect(
      db.prepare("SELECT hostname FROM ip_addresses WHERE ip_address = '10.70.0.150'").get()
        .hostname,
    ).toBe('laptop');
  });
});
