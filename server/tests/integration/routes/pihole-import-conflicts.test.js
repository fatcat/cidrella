import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateConfigs: vi.fn(), generateReverseNames: original.generateReverseNames };
});
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn() };
});

const { default: piholeRouter } = await import('../../../src/routes/pihole.js');
const { default: request } = await import('supertest');

/**
 * Duplicate-logic audit #18, the half that was open on a product decision.
 *
 * The DNS page refuses to give one IP a second hostname and tells the operator
 * to use a CNAME. The Pi-hole importer skipped that check entirely, so a file
 * could quietly do what the UI forbids.
 *
 * Decision taken: reject the whole import and import NOTHING, but the error
 * must name every offending record rather than being a bare 400. Both halves
 * are load-bearing and both are tested here.
 */
let tmpDir, app, db;

async function freshDb() {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(piholeRouter, '/api/pihole');
  db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('audit.lan','forward',1)").run();
  return db.prepare("SELECT id FROM dns_zones WHERE name = 'audit.lan'").get().id;
}

let zoneId;
beforeEach(async () => { zoneId = await freshDb(); });
afterAll(() => cleanupTestDb(tmpDir));

const post = (body) => request(app).post("/api/pihole/import").send({ zoneId, ...body });
const countRecords = () => db.prepare('SELECT COUNT(*) FROM dns_records').pluck().get();

describe('#18: a conflicting A record is rejected and named', () => {
  it('refuses a second name for an address that already has one', async () => {
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled, source) VALUES (?, 'nas', 'A', '10.9.0.5', 1, 'manual')").run(zoneId);

    const res = await post({ hosts: [{ hostname: 'fileserver', ip: '10.9.0.5' }] });

    expect(res.status).toBe(400);
    // The error must be diagnostic on its own: which record, which address,
    // what it clashes with, and what to do instead.
    expect(res.body.error).toContain('fileserver');
    expect(res.body.error).toContain('10.9.0.5');
    expect(res.body.error).toContain('nas.audit.lan');
    expect(res.body.error).toMatch(/CNAME/);
    expect(res.body.problems).toHaveLength(1);
    expect(res.body.problems[0]).toMatchObject({ type: 'A', name: 'fileserver', value: '10.9.0.5' });
  });

  it('names the DHCP reservation when that is the source of the clash', async () => {
    db.prepare("INSERT INTO subnets (cidr, name, prefix_length, network_address, broadcast_address, total_addresses, status, depth, domain_name) VALUES ('10.9.0.0/24','s',24,'10.9.0.0','10.9.0.255',256,'allocated',0,'audit.lan')").run();
    const subnetId = db.prepare("SELECT id FROM subnets WHERE cidr='10.9.0.0/24'").pluck().get();
    db.prepare("INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, enabled) VALUES (?, 'aa:bb:cc:dd:ee:ff', '10.9.0.7', 'printer', 1)").run(subnetId);

    const res = await post({ hosts: [{ hostname: 'scanner', ip: '10.9.0.7' }] });
    expect(res.status).toBe(400);
    expect(res.body.problems[0].reason).toContain('printer');
    expect(res.body.problems[0].reason).toContain('reserved DHCP');
  });

  it('allows the SAME name for the address, which is a re-statement not a clash', async () => {
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled, source) VALUES (?, 'nas', 'A', '10.9.0.5', 1, 'manual')").run(zoneId);
    const res = await post({ hosts: [{ hostname: 'nas', ip: '10.9.0.5' }] });
    expect(res.status).toBe(200);
  });
});

describe('#18: nothing is imported when anything is wrong', () => {
  it('imports none of the good records alongside a bad one', async () => {
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled, source) VALUES (?, 'nas', 'A', '10.9.0.5', 1, 'manual')").run(zoneId);
    const before = countRecords();

    const res = await post({
      hosts: [
        { hostname: 'good-one', ip: '10.9.0.10' },
        { hostname: 'good-two', ip: '10.9.0.11' },
        { hostname: 'clashes', ip: '10.9.0.5' },
      ],
    });

    expect(res.status).toBe(400);
    // The whole point of the decision: no partial import.
    expect(countRecords(), 'nothing should have been written').toBe(before);
  });
});

describe('#18: EVERY offender is reported, not just the first', () => {
  it('lists all bad records in one response', async () => {
    const res = await post({
      hosts: [
        { hostname: 'ok', ip: '10.9.0.10' },
        { hostname: 'bad-ip-1', ip: '999.1.1.1' },
        { hostname: 'bad-ip-2', ip: 'not-an-ip' },
        { hostname: 'bad-ip-3', ip: '10.9.0.300' },
      ],
    });

    expect(res.status).toBe(400);
    // Before this change the handler returned on the first bad row, so an
    // operator fixing a file re-uploaded once per problem.
    expect(res.body.problems).toHaveLength(3);
    const names = res.body.problems.map(p => p.name).sort();
    expect(names).toEqual(['bad-ip-1', 'bad-ip-2', 'bad-ip-3']);
    for (const n of names) expect(res.body.error).toContain(n);
    expect(res.body.error).toContain('3 records');
  });

  it('reports A and CNAME problems together', async () => {
    const res = await post({
      hosts: [{ hostname: 'bad-ip', ip: 'nope' }],
      cnames: [{ alias: 'www', target: 'somewhere.else.example.com' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.problems.map(p => p.type).sort()).toEqual(['A', 'CNAME']);
  });

  it('caps the human-readable message but keeps every problem in the array', async () => {
    const hosts = Array.from({ length: 25 }, (_, i) => ({ hostname: `bad${i}`, ip: 'not-an-ip' }));
    const res = await post({ hosts });
    expect(res.status).toBe(400);
    expect(res.body.problems).toHaveLength(25);
    expect(res.body.error).toContain('and 5 more');
  });
});

describe('#18: duplicate A records inside one import', () => {
  it('rejects the whole import and reports every A record sharing the IP', async () => {
    const body = {
      hosts: [
        { hostname: 'host-a', ip: '10.9.0.20' },
        // Equivalent spellings must collapse before duplicate detection.
        { hostname: 'host-b', ip: '010.009.000.020' },
      ],
    };

    const before = countRecords();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(countRecords()).toBe(before);
    expect(res.body.problems.map(problem => problem.name).sort())
      .toEqual(['host-a', 'host-b']);
    for (const problem of res.body.problems) {
      expect(problem.value).toBe('10.9.0.20');
      expect(problem.reason).toContain('host-a.audit.lan');
      expect(problem.reason).toContain('host-b.audit.lan');
      expect(problem.reason).toMatch(/CNAME/);
    }
  });

  it('still allows an unambiguous import to be repeated', async () => {
    const body = { hosts: [{ hostname: 'host-a', ip: '10.9.0.30' }] };
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
  });
});

describe('Pi-hole import lifecycle ownership', () => {
  it('rolls back the whole import when an existing PTR names another zone', async () => {
    db.prepare(`
      INSERT INTO subnets
        (cidr, name, prefix_length, network_address, broadcast_address,
         total_addresses, status, depth, domain_name, has_reverse_dns)
      VALUES ('10.9.0.0/24', 'import conflict', 24, '10.9.0.0',
              '10.9.0.255', 256, 'allocated', 0, 'audit.lan', 1)
    `).run();
    const reverseZoneId = db.prepare(`
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('0.9.10.in-addr.arpa', 'reverse', 1)
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, '43', 'PTR', 'legacy.other.test', 'manual', 1)
    `).run(reverseZoneId);
    const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');
    invalidateSubnetCache();

    const res = await post({ hosts: [{ hostname: 'imported', ip: '10.9.0.43' }] });

    expect(res.status).toBe(409);
    expect(res.body.ptr_conflict).toMatchObject({
      existing: 'legacy.other.test',
      proposed: 'imported.audit.lan'
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dns_records WHERE type = 'A'").get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT value FROM dns_records WHERE zone_id = ? AND name = ?')
      .get(reverseZoneId, '43')).toEqual({ value: 'legacy.other.test' });
  });

  it('promotes the managed PTR placeholder to the imported DNS hostname', async () => {
    const subnetId = db.prepare(`
      INSERT INTO subnets
        (cidr, name, prefix_length, network_address, broadcast_address,
         total_addresses, status, depth, domain_name, has_reverse_dns)
      VALUES ('10.9.0.0/24', 'import reverse', 24, '10.9.0.0',
              '10.9.0.255', 256, 'allocated', 0, 'audit.lan', 1)
    `).run().lastInsertRowid;
    const reverseZoneId = db.prepare(`
      INSERT INTO dns_zones (name, type, enabled)
      VALUES ('0.9.10.in-addr.arpa', 'reverse', 1)
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, '42', 'PTR', '10.9.0.42', 'placeholder', 1)
    `).run(reverseZoneId);
    const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');
    invalidateSubnetCache();

    expect((await post({ hosts: [{ hostname: 'imported', ip: '10.9.0.42' }] })).status).toBe(200);

    expect(db.prepare(`
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '42'
    `).get(reverseZoneId)).toEqual({ value: 'imported.audit.lan', source: 'dns' });
    expect(db.prepare(`
      SELECT allocation_state FROM ip_addresses
      WHERE subnet_id = ? AND ip_address = '10.9.0.42'
    `).get(subnetId)).toEqual({ allocation_state: 'static_dns' });
  });

  it('moves allocation authority when an imported A record changes address', async () => {
    const subnetId = db.prepare(`
      INSERT INTO subnets
        (cidr, name, prefix_length, network_address, broadcast_address,
         total_addresses, status, depth, domain_name)
      VALUES ('10.9.0.0/24', 'import lifecycle', 24, '10.9.0.0',
              '10.9.0.255', 256, 'allocated', 0, 'audit.lan')
    `).run().lastInsertRowid;
    const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');
    invalidateSubnetCache();

    expect((await post({ hosts: [{ hostname: 'moving', ip: '10.9.0.40' }] })).status).toBe(200);
    expect((await post({ hosts: [{ hostname: 'moving', ip: '10.9.0.41' }] })).status).toBe(200);

    const oldAddress = db.prepare(`
      SELECT allocation_state, allocation_source_type, hostname
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = '10.9.0.40'
    `).get(subnetId);
    const newAddress = db.prepare(`
      SELECT allocation_state, allocation_source_type, hostname
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = '10.9.0.41'
    `).get(subnetId);
    expect(oldAddress).toMatchObject({
      allocation_state: 'unassigned', allocation_source_type: null, hostname: null
    });
    expect(newAddress).toMatchObject({
      allocation_state: 'static_dns', allocation_source_type: 'dns', hostname: 'moving.audit.lan'
    });
  });
});
