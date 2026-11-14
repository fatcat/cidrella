/**
 * Host association (docs/IPV6-HANDLING.md rule 5): address rows grouped into
 * devices by the MACs and DUIDs they carry. A projection: the rows going in
 * are never changed.
 */
import { describe, expect, it } from 'vitest';
import { addressKind, groupHosts, hostMatches } from '../../../src/utils/ip-hosts.js';
import { sortKey } from '../../../src/utils/address.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const HOURS_AGO = (h) =>
  new Date(NOW - h * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

const row = (ip, fields = {}) => ({
  ip_address: ip,
  address_sort_key: sortKey(ip),
  address_family: ip.includes(':') ? 6 : 4,
  allocation_state: 'unassigned',
  ...fields,
});

const group = (rows, links) => groupHosts(rows, links, { now: NOW });
const addressesOf = (host) => host.addresses.map((a) => a.ip_address);

describe('groupHosts', () => {
  it('keys a DUID-only DHCPv6 host by its DUID', () => {
    const duid = '00:02:00:00:ab:11:01:02:03:04';
    const [host] = group([
      row('fd00:5::100', { allocation_state: 'dynamic_dhcp', dhcp_duid: duid, dhcp_version: 6 }),
    ]);
    expect(host).toMatchObject({ key: `duid:${duid}`, key_kind: 'duid', duid, mac: null });
    expect(host.addresses[0].kind).toBe('dhcp');
  });

  it('joins the SLAAC addresses the neighbor table gave one MAC', () => {
    const mac = 'aa:bb:cc:00:00:01';
    const hosts = group([
      row('fd00:5::7f2e:91c4:aa01:3b6d', { allocation_state: 'slaac', last_seen_mac: mac }),
      row('fd00:5::c0a8:1:2', { allocation_state: 'slaac', last_seen_mac: 'AA:BB:CC:00:00:01' }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ key: `mac:${mac}`, key_kind: 'mac', mac });
  });

  it('joins an EUI-64 address to the rows carrying the MAC it encodes', () => {
    const hosts = group([
      row('fd00:5::21a:2bff:fe3c:4d5e', { allocation_state: 'slaac' }),
      row('fd00:5::1234', { allocation_state: 'slaac', last_seen_mac: '00:1a:2b:3c:4d:5e' }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].mac).toBe('00:1a:2b:3c:4d:5e');
    expect(hosts[0].addresses.find((a) => a.kind === 'eui64').ip_address).toBe(
      'fd00:5::21a:2bff:fe3c:4d5e',
    );
  });

  it('joins a DUID row to a MAC row through a lease that holds both', () => {
    const duid = '00:02:00:00:ab:11:09:09';
    const mac = 'aa:bb:cc:00:00:02';
    const rows = [
      row('fd00:5::200', { allocation_state: 'dynamic_dhcp', dhcp_duid: duid }),
      row('fd00:5::aaaa', { allocation_state: 'slaac', last_seen_mac: mac }),
    ];
    expect(group(rows)).toHaveLength(2);
    const joined = group(rows, [{ mac, duid }]);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ key: `mac:${mac}`, duid });
  });

  it('reads the MAC inside a DUID-LL as a join', () => {
    // DUID-LL: type 3, hardware type 1, then the MAC.
    const hosts = group([
      row('fd00:5::300', { dhcp_duid: '00:03:00:01:aa:bb:cc:00:00:03', dhcp_version: 6 }),
      row('fd00:5::abcd', { last_seen_mac: 'aa:bb:cc:00:00:03', allocation_state: 'slaac' }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].key).toBe('mac:aa:bb:cc:00:00:03');
  });

  it('keeps a link-local address on two interfaces as two identities of one host', () => {
    const mac = 'aa:bb:cc:00:00:04';
    const hosts = group([
      row('fe80::1', { interface_id: 'eth0', last_seen_mac: mac }),
      row('fe80::1', { interface_id: 'eth1', last_seen_mac: mac }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].addresses.map((a) => a.interface_id)).toEqual(['eth0', 'eth1']);
    expect(hosts[0].addresses.every((a) => a.kind === 'link-local')).toBe(true);
  });

  it('makes an address with no evidence a host of its own', () => {
    const hosts = group([
      row('fd00:5::10', { allocation_state: 'static_dns', hostname: 'nas' }),
      row('fe80::9', { interface_id: 'eth0' }),
    ]);
    expect(hosts.map((h) => h.key)).toEqual(['address:fd00:5::10', 'address:fe80::9%eth0']);
    expect(hosts[0]).toMatchObject({ key_kind: 'address', name: 'nas', stable_count: 1 });
  });

  it('marks a young SLAAC address beside an established one as temporary', () => {
    const mac = 'aa:bb:cc:00:00:05';
    const [host] = group([
      row('fd00:5::1111', {
        allocation_state: 'slaac',
        last_seen_mac: mac,
        first_seen_at: HOURS_AGO(72),
      }),
      row('fd00:5::2222', {
        allocation_state: 'slaac',
        last_seen_mac: mac,
        first_seen_at: HOURS_AGO(2),
      }),
      row('fd00:5::3333', {
        allocation_state: 'slaac',
        last_seen_mac: mac,
        detection_source: 'slaac_privacy',
      }),
    ]);
    const kinds = Object.fromEntries(host.addresses.map((a) => [a.ip_address, a.kind]));
    expect(kinds).toEqual({
      'fd00:5::1111': 'slaac',
      'fd00:5::2222': 'temporary',
      'fd00:5::3333': 'temporary',
    });
    expect(host).toMatchObject({ temporary_count: 2, stable_count: 0, other_count: 3 });
  });

  it('leaves a young SLAAC address alone when nothing older shares its /64', () => {
    const mac = 'aa:bb:cc:00:00:06';
    const [host] = group([
      row('fd00:5::1111', {
        allocation_state: 'slaac',
        last_seen_mac: mac,
        first_seen_at: HOURS_AGO(2),
      }),
      row('fd00:6::1111', {
        allocation_state: 'slaac',
        last_seen_mac: mac,
        first_seen_at: HOURS_AGO(90),
      }),
    ]);
    expect(host.addresses.map((a) => a.kind)).toEqual(['slaac', 'slaac']);
  });

  it('names a host from its stable addresses and lists every name', () => {
    const mac = 'aa:bb:cc:00:00:07';
    const [host] = group([
      row('fd00:5::50', { allocation_state: 'slaac', last_seen_mac: mac, hostname: 'phone-slaac' }),
      row('fd00:5::60', {
        allocation_state: 'static_dhcp',
        mac_address: mac,
        hostname: 'phone',
        has_dhcp_reservation: 1,
      }),
    ]);
    expect(host.name).toBe('phone');
    expect(host.hostnames).toEqual(['phone-slaac', 'phone']);
    expect(host.addresses.map((a) => a.kind)).toEqual(['slaac', 'reservation']);
  });

  it('groups IPv4 rows the same way', () => {
    const hosts = group([
      row('10.0.0.5', { allocation_state: 'dynamic_dhcp', mac_address: 'aa:bb:cc:00:00:08' }),
      row('10.0.0.9', { allocation_state: 'reserved' }),
    ]);
    expect(hosts.map((h) => h.key)).toEqual(['mac:aa:bb:cc:00:00:08', 'address:10.0.0.9']);
    expect(hosts.map((h) => h.addresses[0].kind)).toEqual(['dhcp', 'static']);
  });

  it('sorts hosts by their lowest stable address and never changes the rows', () => {
    const rows = [
      row('fd00:5::900', { allocation_state: 'reserved' }),
      row('fd00:5::5', { allocation_state: 'slaac', last_seen_mac: 'aa:bb:cc:00:00:09' }),
      row('fd00:5::800', { allocation_state: 'static_dns', mac_address: 'aa:bb:cc:00:00:09' }),
    ];
    const before = JSON.stringify(rows);
    expect(group(rows).map(addressesOf)).toEqual([['fd00:5::5', 'fd00:5::800'], ['fd00:5::900']]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('addressKind', () => {
  it('names DHCPv4 and DHCPv6 leases alike', () => {
    expect(addressKind(row('10.0.0.5', { detection_source: 'dhcp_lease' }))).toBe('dhcp');
    expect(addressKind(row('fd00::5', { detection_source: 'dhcpv6_lease' }))).toBe('dhcp');
  });
});

describe('hostMatches', () => {
  const [host] = group([
    row('fd00:5::21a:2bff:fe3c:4d5e', { allocation_state: 'slaac', hostname: 'laptop' }),
  ]);

  it('matches an address in any spelling, a CIDR, a name or the MAC', () => {
    expect(hostMatches(host, 'fd00:0005:0000:0000:021a:2bff:fe3c:4d5e')).toBe(true);
    expect(hostMatches(host, 'fd00:5::/64')).toBe(true);
    expect(hostMatches(host, 'fd00:6::/64')).toBe(false);
    expect(hostMatches(host, 'LAPTOP')).toBe(true);
    expect(hostMatches(host, '00:1a:2b')).toBe(true);
    expect(hostMatches(host, '')).toBe(true);
    expect(hostMatches(host, 'printer')).toBe(false);
  });

  it('matches an IPv4 host by address and CIDR', () => {
    const [v4] = group([row('10.0.0.5', { mac_address: 'aa:bb:cc:00:00:08' })]);
    expect(hostMatches(v4, '10.0.0.5')).toBe(true);
    expect(hostMatches(v4, '10.0.0.0/24')).toBe(true);
    expect(hostMatches(v4, '10.0.1.0/24')).toBe(false);
  });
});
