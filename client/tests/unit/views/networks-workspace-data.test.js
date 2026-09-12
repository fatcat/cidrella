import { describe, expect, it } from 'vitest';
import {
  buildExplorerFolders,
  mapAddressRows,
  mapDhcpScopeRows,
  mapDhcpRows,
  mapDnsRows,
  mapDnsZoneRows,
  mapNetworkRows,
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
        is_online: 0,
      },
    ]);

    expect(row.assignment).toBe('Reserved');
    expect(row.leaseStatus).toBe('offline');
    expect(row.expires).toBe('Never');
    expect(row.source).toBe('DHCP Reservation');
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
    expect(row.source).toBe('DHCP');
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
