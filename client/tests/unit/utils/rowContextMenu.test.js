import { describe, expect, it } from 'vitest';
import {
  canAddDhcpReservation,
  dnsRecordProbeIp,
  isEditableDhcpReservation,
  isEditableDnsRecord,
  isImmutableNetworkAddress,
  managedDnsRecordMenuItem,
  probeNowMenuItem
} from '../../../src/utils/rowContextMenu.js';

describe('row context menu policy', () => {
  it.each([
    ['dns', 'Managed by forward DNS record'],
    ['dhcp', 'Managed by DHCP lease'],
    ['reservation', 'Managed by DHCP Reservation'],
    ['placeholder', 'Generated reverse DNS placeholder']
  ])('gives %s-managed DNS rows an explanatory menu item', (source, label) => {
    expect(managedDnsRecordMenuItem({ dns_source: source })).toEqual({
      label,
      icon: 'pi pi-lock',
      disabled: true
    });
  });

  it('leaves operator-managed DNS rows editable', () => {
    expect(managedDnsRecordMenuItem({ dns_source: 'manual' })).toBeNull();
    expect(managedDnsRecordMenuItem({ dns_source: null })).toBeNull();
    expect(isEditableDnsRecord({ dns_source: 'manual' })).toBe(true);
    expect(isEditableDnsRecord({ dns_source: null })).toBe(true);
  });

  it.each(['dns', 'dhcp', 'reservation', 'placeholder'])('does not double-click edit %s-managed DNS rows', (source) => {
    expect(isEditableDnsRecord({ dns_source: source })).toBe(false);
  });

  it('only double-click edits DHCP Reservation rows', () => {
    expect(isEditableDhcpReservation({ dhcp_assignment_type: 'reserved' })).toBe(true);
    expect(isEditableDhcpReservation({ dhcp_assignment_type: 'dynamic' })).toBe(false);
    expect(isEditableDhcpReservation({ dhcp_assignment_type: 'available' })).toBe(false);
  });

  it('offers adding a DHCP Reservation for IP rows that are not already reservations', () => {
    expect(canAddDhcpReservation({ ip_address: '10.0.0.10', dhcp_assignment_type: 'available' })).toBe(true);
    expect(canAddDhcpReservation({ ip_address: '10.0.0.11', dhcp_assignment_type: 'dynamic' })).toBe(true);
    expect(canAddDhcpReservation({ ip_address: '10.0.0.12', dhcp_assignment_type: 'reserved' })).toBe(false);
    expect(canAddDhcpReservation({ dhcp_assignment_type: 'available' })).toBe(false);
  });

  it('treats only the network and broadcast identities as immutable table rows', () => {
    expect(isImmutableNetworkAddress({ range_type_name: 'Network' })).toBe(true);
    expect(isImmutableNetworkAddress({ range_type_name: 'Broadcast' })).toBe(true);
    expect(isImmutableNetworkAddress({ range_type_name: 'Gateway' })).toBe(false);
    expect(isImmutableNetworkAddress({ range_type_name: 'DHCP Scope' })).toBe(false);
  });

  it('builds one consistent Probe Now action for row menus', () => {
    const command = () => {};
    expect(probeNowMenuItem(command)).toEqual({
      label: 'Probe Now',
      icon: 'pi pi-wifi',
      command
    });
  });

  it('finds probeable IPv4 addresses on forward A and reverse PTR rows', () => {
    expect(dnsRecordProbeIp({ record_type: 'A', value: '10.0.0.10' })).toBe('10.0.0.10');
    expect(dnsRecordProbeIp({ record_type: 'A', ip_address: '10.0.0.11', value: 'stale' })).toBe('10.0.0.11');
    expect(dnsRecordProbeIp({ record_type: 'PTR' }, '10.0.0.12')).toBe('10.0.0.12');
    expect(dnsRecordProbeIp({ record_type: 'CNAME', value: 'host.example.com' })).toBeNull();
    expect(dnsRecordProbeIp({ record_type: 'AAAA', value: '2001:db8::1' })).toBeNull();
    expect(dnsRecordProbeIp({ record_type: 'A', value: 'not-an-ip' })).toBeNull();
  });
});
