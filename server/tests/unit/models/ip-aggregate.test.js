import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';
import { buildIpAggregate } from '../../../src/models/ip-view.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  subnetId = db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status)
    VALUES ('10.88.0.0/24', 'Aggregate', '10.88.0.0', '10.88.0.255',
            24, 256, 'allocated')
  `).run().lastInsertRowid;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('canonical IP aggregate schema', () => {
  it('installs canonical identity and allocation columns and indexes', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name));
    for (const name of [
      'allocation_state', 'allocation_source_type', 'allocation_source_id',
      'address_family', 'address_sort_key', 'interface_id', 'preferred_until',
      'valid_until', 'dhcp_version'
    ]) {
      expect(columns, name).toContain(name);
    }

    const indexes = new Set(db.prepare('PRAGMA index_list(ip_addresses)').all().map(row => row.name));
    expect(indexes).toContain('idx_ip_addresses_allocation');
    expect(indexes).toContain('idx_ip_addresses_canonical_sort');
  });

  it('canonicalizes new IPv6 writes and records a numeric sort identity', () => {
    IpAddress.upsert(db, subnetId, '2001:0DB8:0:0:0:0:0:88', {
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      preferred_until: '2029-12-31T23:00:00.000Z',
      valid_until: '2030-01-01T00:00:00.000Z'
    });

    const row = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = '2001:db8::88'").get();
    expect(row).toMatchObject({
      address_family: 6,
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      interface_id: null
    });
    expect(row.address_sort_key).toHaveLength(33);
  });

  it('folds IPv4-mapped input onto the canonical IPv4 row', () => {
    const firstId = IpAddress.upsert(db, subnetId, '10.88.0.89', { hostname: 'mapped' });
    const secondId = IpAddress.upsert(db, subnetId, '::ffff:10.88.0.89', { is_online: 1 });

    expect(secondId).toBe(firstId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM ip_addresses WHERE ip_address = '10.88.0.89'").get().count)
      .toBe(1);
  });

  it('requires and separates IPv6 link-local interface context', () => {
    expect(() => IpAddress.upsert(db, subnetId, 'fe80::88', {}))
      .toThrow(/require interface context/);

    IpAddress.upsert(db, subnetId, 'fe80::88%eth0', {});
    const row = db.prepare("SELECT * FROM ip_addresses WHERE ip_address = 'fe80::88'").get();
    expect(row.interface_id).toBe('eth0');
  });
});

describe('canonical IP read aggregate', () => {
  it('adds canonical identity to synthesized protocol rows', () => {
    expect(buildIpAggregate({
      ip_address: '2001:0DB8:0:0:0:0:0:90',
      has_static_dns: 1
    })).toMatchObject({
      ip_address: '2001:db8::90',
      address_family: 6,
      address_type: 'static DNS'
    });
  });

  it('projects allocation, SLAAC, pool, and conflict states without changing liveness', () => {
    expect(buildIpAggregate({ allocation_state: 'slaac', is_online: 0 })).toMatchObject({
      allocation_state: 'slaac',
      address_type: 'SLAAC',
      ip_display_status: 'in use',
      is_online: 0
    });
    expect(buildIpAggregate({ allocation_state: 'unassigned', in_dynamic_pool: 1 })).toMatchObject({
      address_type: null,
      ip_display_status: 'DHCP Scope'
    });
    expect(buildIpAggregate({
      allocation_state: 'static_dns',
      is_rogue: 1,
      rogue_reason: 'MAC mismatch'
    })).toMatchObject({
      address_type: 'static DNS',
      address_conflict: true,
      address_conflict_reason: 'MAC mismatch'
    });
  });
});
