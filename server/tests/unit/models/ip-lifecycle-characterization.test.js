import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { FAMILY_NEUTRAL_LIFECYCLE_FIXTURES } from '../../fixtures/ip-lifecycle-0_4_17.js';
import { addressFamily, canonicalizeIp, parseIp } from '../../../src/utils/address.js';

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});

afterAll(() => cleanupTestDb(tmpDir));

describe('canonical lifecycle schema', () => {
  it('stores only the canonical allocation vocabulary', () => {
    const columns = db.prepare('PRAGMA table_info(ip_addresses)').all().map(row => row.name);

    expect(columns).toContain('allocation_state');
    expect(columns).not.toContain('status');
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ip_addresses'").get().sql;
    for (const state of ['unassigned', 'reserved', 'static_dns', 'static_dhcp', 'dynamic_dhcp', 'slaac', 'system', 'gateway', 'quarantined']) {
      expect(tableSql).toContain(`'${state}'`);
    }
  });

  it('rejects a legacy allocation value', () => {
    expect(() => db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, allocation_state, address_family, address_sort_key)
      VALUES (1, '10.77.0.40', 'locked', 4, 'legacy')
    `).run()).toThrow();
  });

  it('keeps family-neutral address fixtures valid', () => {
    const fixtures = FAMILY_NEUTRAL_LIFECYCLE_FIXTURES;
    expect(canonicalizeIp(fixtures.canonicalIpv6.input)).toBe(fixtures.canonicalIpv6.canonical);
    expect(addressFamily(fixtures.canonicalIpv6.input)).toBe(fixtures.canonicalIpv6.family);
    expect(canonicalizeIp(fixtures.mappedIpv4.input)).toBe(fixtures.mappedIpv4.canonical);
    expect(addressFamily(fixtures.mappedIpv4.input)).toBe(fixtures.mappedIpv4.family);
    expect(parseIp(fixtures.linkLocal.input).zoneId).toBe(fixtures.linkLocal.interfaceContext);
    expect(fixtures.dhcpv6).toMatchObject({ duid: expect.any(String), iaid: expect.any(String) });
    expect(fixtures.slaac.temporary).toBe(true);
    expect(fixtures.ipv6Subnet.broadcast).toBeNull();
  });
});
