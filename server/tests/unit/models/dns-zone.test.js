import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DnsZone from '../../../src/models/dns-zone.js';

let db;
let tmpDir;

const soaDefaults = {
  soa_primary_ns: 'ns1.example.test',
  soa_admin_email: 'admin.example.test',
  soa_refresh: 3600,
  soa_retry: 900,
  soa_expire: 604800,
  soa_minimum_ttl: 86400
};

function createSubnet(name, cidr, domainName) {
  const [networkAddress] = cidr.split('/');
  return db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, status, domain_name
    )
    VALUES (?, ?, ?, ?, 24, 256, 'allocated', ?)
  `).run(cidr, name, networkAddress, networkAddress.replace(/\.\d+$/, '.255'), domainName).lastInsertRowid;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM subnets').run();
  db.prepare('DELETE FROM dns_zones').run();
});

describe('DNS zone ownership', () => {
  it('creates zones with SOA defaults', () => {
    const zone = DnsZone.createZone(db, {
      name: 'example.test',
      type: 'forward',
      description: 'Example zone'
    }, soaDefaults);

    expect(zone.name).toBe('example.test');
    expect(zone.description).toBe('Example zone');
    expect(zone.soa_primary_ns).toBe('ns1.example.test');
    expect(zone.soa_admin_email).toBe('admin.example.test');
  });

  it('renames forward zones and updates matching subnet domain pointers', () => {
    createSubnet('a', '10.1.0.0/24', 'before.test');
    createSubnet('b', '10.2.0.0/24', 'before.test');
    const zone = DnsZone.createZone(db, { name: 'before.test', type: 'forward' }, soaDefaults);

    const updated = DnsZone.updateZone(db, zone, { name: 'after.test' });
    const domains = db.prepare('SELECT domain_name FROM subnets ORDER BY name').all();

    expect(updated.name).toBe('after.test');
    expect(updated.soa_serial).toBe(2);
    expect(domains.map(row => row.domain_name)).toEqual(['after.test', 'after.test']);
  });

  it('deletes forward zones and clears matching subnet domain pointers', () => {
    createSubnet('a', '10.1.0.0/24', 'gone.test');
    createSubnet('b', '10.2.0.0/24', 'gone.test');
    const zone = DnsZone.createZone(db, { name: 'gone.test', type: 'forward' }, soaDefaults);

    DnsZone.deleteZone(db, zone);

    const deleted = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zone.id);
    const domains = db.prepare('SELECT domain_name FROM subnets ORDER BY name').all();
    expect(deleted).toBeUndefined();
    expect(domains.map(row => row.domain_name)).toEqual([null, null]);
  });
});
