import { describe, expect, it } from 'vitest';
import { EMPTY_CELL } from '../../../src/utils/format.js';
import {
  buildExplorerFolders,
  mapAddressRows,
  mapDhcpScopeRows,
  mapDhcpRows,
  mapDnsRows,
  mapDnsZoneRows,
  mapNetworkRows,
  addressCountLabel,
  dnsRecordSummary,
} from '../../../src/views/networks-workspace-data.js';

describe('networks workspace data adapter', () => {
  it('renders server-owned IP status and type without reconstructing allocation precedence', () => {
    const [row] = mapAddressRows([
      {
        ip_address: '10.0.0.20',
        allocation_state: 'static_dns',
        ip_display_status: 'DHCP Scope',
        address_type: 'static DNS',
        is_online: '0',
        scanning_enabled: false,
        scan_enabled: null,
      },
    ]);

    expect(row.status).toBe('DHCP Scope');
    expect(row.type).toBe('static DNS');
    expect(row.online).toBe('offline');
    expect(row.scanning).toBe('Off · inherited');
  });

  it('uses explicit DHCP assignment and lease fields', () => {
    const [row] = mapDhcpRows([
      {
        id: 7,
        ip_address: '10.0.0.33',
        dhcp_assignment_type: 'reserved',
        lease_status: 'offline',
        expires_at: null,
        dhcp_expires_at: null,
        dhcp_lease_state: null,
        allocation_source_type: 'dhcp_reservation',
        enabled: 1,
        is_online: 0,
      },
    ]);

    expect(row.assignment).toBe('Reserved');
    expect(row.leaseStatus).toBe('offline');
    expect(row.lease).toBeNull();
    expect(row.expires).toBe('Never');
    expect(row.source).toBe('DHCP Reservation');
    expect(row.enabled).toBe(true);
  });

  it('fills the shared IP columns the same way from either table', () => {
    // The same server facts about one address, as the addresses read and
    // the DHCP read each present them.
    const facts = {
      ip_address: '10.0.0.22',
      hostname: 'S24-Ultra',
      ip_display_status: 'in use',
      address_type: 'DHCP Reservation',
      dhcp_expires_at: 'infinite',
      dhcp_lease_state: 'active',
      allocation_source_type: 'dhcp_reservation',
      network_range_type: 'Phones',
      last_seen_at: new Date().toISOString(),
      scanning_enabled: true,
      scan_enabled: null,
      is_online: 0,
    };
    const [address] = mapAddressRows([{ ...facts, has_dhcp_reservation: 1 }]);
    const [dhcp] = mapDhcpRows([
      { ...facts, id: 9, dhcp_assignment_type: 'reserved', expires_at: 'infinite' },
    ]);
    const dhcpOnly = new Set([
      'id',
      'raw',
      'assignment',
      'pool',
      'leaseStatus',
      'enabled',
      'network',
    ]);
    const shared = (row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !dhcpOnly.has(key)));
    expect(shared(dhcp)).toEqual(shared(address));
    expect(address.lease).toBe('Active');
    expect(address.expires).toBe('Never');
    expect(address.source).toBe('DHCP Reservation');
    expect(address.scanning).toBe('On · inherited');
    expect(address.lastSeen).toBe('Just now');

    // A free pool address has a status, no lease and no source, in both.
    const [freeAddress] = mapAddressRows([
      { ip_address: '10.0.0.16', ip_display_status: 'DHCP Scope', is_online: 0 },
    ]);
    const [freePool] = mapDhcpRows([
      {
        id: 'available:2:10.0.0.16',
        ip_address: '10.0.0.16',
        ip_display_status: 'DHCP Scope',
        dhcp_assignment_type: null,
        lease_status: 'available',
        is_online: 0,
      },
    ]);
    expect(shared(freePool)).toEqual(shared(freeAddress));
    expect(freePool.status).toBe('DHCP Scope');
    expect(freePool.lease).toBeNull();
    expect(freePool.source).toBeNull();
    expect(freePool.expires).toBe(EMPTY_CELL);
  });

  it('tags held addresses with their pool membership', () => {
    const base = { id: 1, ip_address: '10.0.0.40', lease_status: 'active', is_online: 1 };
    const [reservedIn, reservedOut, leaseOut, free] = mapDhcpRows([
      { ...base, dhcp_assignment_type: 'reserved', related_scope_ids: [3] },
      { ...base, dhcp_assignment_type: 'reserved', related_scope_ids: [] },
      { ...base, dhcp_assignment_type: 'dynamic', related_scope_ids: [] },
      { ...base, dhcp_assignment_type: null, lease_status: 'available', related_scope_ids: [3] },
    ]);
    expect(reservedIn.pool).toEqual({ label: 'in pool', tone: 'muted' });
    // A reservation outside the pool is deliberate; a lease outside it is not.
    expect(reservedOut.pool).toEqual({ label: 'outside pool', tone: 'muted' });
    expect(leaseOut.pool).toEqual({ label: 'outside pool', tone: 'warn' });
    expect(free.pool).toBeNull();
  });

  it('shows a record without its own TTL as inheriting the zone TTL', () => {
    const zone = { id: 4, name: 'example.test', type: 'forward', soa_minimum_ttl: 3600 };
    const record = { id: 1, record_type: 'A', name: 'a', value: '10.0.0.1', enabled: 1 };
    const [inherited, own, unknown] = mapDnsRows([
      { zone, records: [record, { ...record, id: 2, ttl: 300 }] },
      { zone: { id: 5, name: 'other.test', type: 'forward' }, records: [{ ...record, id: 3 }] },
    ]);
    expect(inherited.ttl).toBe('3,600 · inherited');
    expect(own.ttl).toBe('300');
    expect(unknown.ttl).toBe(EMPTY_CELL);
  });

  it('uses DNS read-model names instead of ambiguous bare fields', () => {
    const [row] = mapDnsRows([
      {
        zone: { id: 4, name: 'example.test', type: 'forward' },
        records: [
          {
            id: 9,
            record_type: 'A',
            dns_source: 'dhcp',
            name: 'host',
            value: '10.0.0.33',
            ttl: 300,
            enabled: 1,
            is_online: 1,
            ip_address: '10.0.0.33',
          },
        ],
      },
    ]);

    expect(row.recordType).toBe('A');
    expect(row.source).toBe('DHCP lease');
    expect(row.zone).toBe('example.test');
  });

  it('keeps allocated descendants while excluding unallocated containers', () => {
    const folders = buildExplorerFolders([
      {
        id: 1,
        name: 'Lab',
        subnets: [
          {
            id: 10,
            cidr: '10.0.0.0/24',
            status: 'unallocated',
            children: [
              {
                id: 11,
                cidr: '10.0.0.0/25',
                name: 'Lower half',
                status: 'allocated',
                total_addresses: 128,
                used_count: 32,
                children: [],
              },
            ],
          },
        ],
      },
    ]);

    expect(folders).toHaveLength(1);
    expect(folders[0].networks.map((network) => network.cidr)).toEqual(['10.0.0.0/25']);
    expect(folders[0].networks[0].used).toBe(25);
  });

  it('maps aggregate network, zone, and scope inventories without inventing IP state', () => {
    const [network] = mapNetworkRows([
      {
        id: 11,
        name: 'Lab',
        cidr: '10.0.0.0/24',
        folder: 'Sites',
        vlan: 10,
        domain: 'lab.example',
        gateway: '10.0.0.1',
        used: 25,
        status: 'allocated',
      },
    ]);
    const [zone] = mapDnsZoneRows(
      [{ id: 21, name: 'lab.example', type: 'forward', record_count: 4, enabled: 1 }],
      new Map([[21, 'Lab']]),
    );
    const [scope] = mapDhcpScopeRows([
      {
        id: 31,
        subnet_name: 'Lab',
        start_ip: '10.0.0.33',
        end_ip: '10.0.0.126',
        lease_time: 43200,
        enabled: 1,
        pools: [{ start_ip: '10.0.0.33', end_ip: '10.0.0.126' }],
      },
    ]);

    expect(network).toMatchObject({ cidr: '10.0.0.0/24', utilization: '25%', status: 'Allocated' });
    expect(zone).toMatchObject({
      name: 'lab.example',
      networks: 'Lab',
      records: '4',
      enabled: true,
    });
    expect(scope).toMatchObject({
      network: 'Lab',
      poolSize: '94 addresses',
      leaseTime: '12 hr',
      enabled: true,
    });
  });
});

describe('addressCountLabel', () => {
  it('names the network total for an enumerable network', () => {
    expect(addressCountLabel({ shown: 20, matching: 40, total: 256 })).toBe(
      'Showing 20 on this page · 40 matching · 256 addresses in network',
    );
  });

  it('names assigned addresses for a sparse IPv6 network, which has no total', () => {
    expect(addressCountLabel({ shown: 256, matching: 256, total: 256, paged: false })).toBe(
      'Showing 256 · 256 matching · 256 addresses in network',
    );
    expect(addressCountLabel({ shown: 3, matching: 3, total: 3, sparse: true })).toBe(
      'Showing 3 on this page · 3 matching · 3 assigned addresses',
    );
  });
});

describe('IPv6 networks in the explorer data', () => {
  it('carry no utilization percentage', () => {
    const folders = buildExplorerFolders([
      {
        id: 1,
        name: 'Lab',
        subnets: [
          {
            id: 9,
            name: 'lab6',
            cidr: 'fd00:1::/64',
            status: 'allocated',
            address_family: 6,
            total_addresses: null,
            used_count: 2,
          },
        ],
      },
    ]);
    expect(folders[0].networks[0].used).toBeNull();
    expect(folders[0].networks[0].state).toBe('healthy');
    expect(mapNetworkRows(folders[0].networks)[0].utilization).toBe('—');
  });
});

describe('dnsRecordSummary', () => {
  const rec = (enabled) => ({ enabled });
  it('counts records and names the disabled ones', () => {
    expect(dnsRecordSummary([rec(true)])).toEqual({
      total: 1,
      disabled: 0,
      note: '1 record references this address',
    });
    expect(dnsRecordSummary([rec(true), rec(true)]).note).toBe('2 records reference this address');
    expect(dnsRecordSummary([rec(false)]).note).toBe('1 disabled record references this address');
    expect(dnsRecordSummary([rec(false), rec(false)]).note).toBe(
      '2 disabled records reference this address',
    );
    expect(dnsRecordSummary([rec(true), rec(false), rec(true)])).toEqual({
      total: 3,
      disabled: 1,
      note: '3 records reference this address, 1 disabled',
    });
  });
});
