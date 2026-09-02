import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import {
  FAMILY_NEUTRAL_LIFECYCLE_FIXTURES,
  seedLegacyLifecycleContradictions
} from '../../fixtures/ip-lifecycle-0_4_17.js';
import { addressFamily, canonicalizeIp, parseIp } from '../../../src/utils/address.js';

let db;
let tmpDir;
let subnetId;
let scopeId;
let regenerateScopeConfigs;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  ({ subnetId, scopeId } = seedLegacyLifecycleContradictions(db));
  vi.resetModules();
  ({ regenerateScopeConfigs } = await import('../../../src/utils/dhcp.js'));
});

afterAll(() => cleanupTestDb(tmpDir));

describe('0.4.17 lifecycle characterization', () => {
  it('permits a locked rogue address to also carry an active lease', () => {
    const facts = db.prepare(`
      SELECT ip.status, ip.is_rogue, lease.expires_at
      FROM ip_addresses ip
      JOIN dhcp_leases lease
        ON lease.subnet_id = ip.subnet_id AND lease.ip_address = ip.ip_address
      WHERE ip.subnet_id = ? AND ip.ip_address = '10.77.0.40'
    `).get(subnetId);

    expect(facts).toEqual({ status: 'locked', is_rogue: 1, expires_at: 'infinite' });
  });

  it('permits manual DNS and static DHCP to claim the same address', () => {
    const facts = db.prepare(`
      SELECT dns.name AS dns_name, reservation.hostname AS reservation_name
      FROM dns_records dns
      JOIN dhcp_reservations reservation ON reservation.ip_address = dns.value
      WHERE reservation.subnet_id = ? AND dns.value = '10.77.0.50'
    `).get(subnetId);

    expect(facts).toEqual({ dns_name: 'dns-host', reservation_name: 'reserved-host' });
  });

  it('permits equivalent IPv6 spellings and unscoped link-local rows', () => {
    const rows = db.prepare(`
      SELECT ip_address FROM ip_addresses
      WHERE subnet_id = ? AND ip_address LIKE '%:%'
      ORDER BY ip_address
    `).all(subnetId).map(row => row.ip_address);

    expect(rows).toEqual(['2001:0db8:0:0:0:0:0:60', '2001:db8::60', 'fe80::1']);
  });

  it('permits disabled protocol rows to leave active-looking IP state behind', () => {
    const rows = db.prepare(`
      SELECT ip_address, status, detection_source FROM ip_addresses
      WHERE subnet_id = ? AND ip_address IN ('10.77.0.70', '10.77.0.71')
      ORDER BY ip_address
    `).all(subnetId);

    expect(rows).toEqual([
      { ip_address: '10.77.0.70', status: 'assigned', detection_source: 'dns' },
      { ip_address: '10.77.0.71', status: 'dhcp', detection_source: 'dhcp_reservation' }
    ]);
  });

  it('provides family-neutral fixtures for future adapters', () => {
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

  it('captures dnsmasq scope output that lacks a locked-address exclusion', () => {
    regenerateScopeConfigs(db);
    const output = fs.readFileSync(
      path.join(tmpDir, 'dnsmasq', 'conf.d', `dhcp-scope-${scopeId}.conf`),
      'utf8'
    );

    expect(output).toContain('dhcp-range=set:scope');
    expect(output).toContain('10.77.0.20,10.77.0.200');
    expect(output).not.toContain('10.77.0.40');
  });
});

describe('target lifecycle behavior captured before implementation', () => {
  it.todo('rejects or quarantines a dynamic lease on a reserved address');
  it.todo('rejects simultaneous static DNS and static DHCP claims');
  it.todo('folds equivalent and IPv4-mapped address spellings into one identity');
  it.todo('requires interface context for IPv6 link-local persistence');
  it.todo('excludes reserved addresses inside dynamic pools from dnsmasq leases');
  it.todo('rejects static DNS inside an enabled same-family dynamic pool');
  it.todo('ignores disabled DNS, reservation, and scope rows as live claims');
  it.todo('retires learned dynamic and rogue metadata after one hour offline');
  it.todo('preserves static assignment observations indefinitely');
  it.todo('upgrades and restores 0.4.17 fixtures without silent claim loss');
});
