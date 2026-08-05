import { describe, expect, it } from 'vitest';
import {
  addressTypeForDhcpAssignment,
  addressTypeForDnsSource,
  ipLifecycleDisplay,
  ipLifecycleDisplayForDhcpRow
} from '../../../src/utils/ipLifecycleDisplay.js';

describe('address type display', () => {
  it('maps DNS sources to the shared Type pills', () => {
    expect(addressTypeForDnsSource('manual')).toMatchObject({ label: 'static DNS', className: 'type-static-dns' });
    expect(addressTypeForDnsSource('dhcp')).toMatchObject({ label: 'dynamic DHCP', className: 'type-dynamic-dhcp' });
    expect(addressTypeForDnsSource('reservation')).toMatchObject({ label: 'reserved DHCP', className: 'type-reserved-dhcp' });
  });

  it('maps DHCP rows to the shared Type pills', () => {
    expect(addressTypeForDhcpAssignment('dynamic')).toMatchObject({ label: 'dynamic DHCP', className: 'type-dynamic-dhcp' });
    expect(addressTypeForDhcpAssignment('reserved')).toMatchObject({ label: 'reserved DHCP', className: 'type-reserved-dhcp' });
  });
});

describe('ipLifecycleDisplay', () => {
  it('shows static DNS for DNS-backed addresses', () => {
    expect(ipLifecycleDisplay({ status: 'assigned', hostname: 'host' }).addressType)
      .toMatchObject({ label: 'static DNS', className: 'type-static-dns' });
  });

  it('shows reserved DHCP for DHCP reservations', () => {
    expect(ipLifecycleDisplay({ has_dhcp_reservation: 1 }).addressType)
      .toMatchObject({ label: 'reserved DHCP', className: 'type-reserved-dhcp' });
  });

  it('shows dynamic DHCP for active DHCP leases', () => {
    expect(ipLifecycleDisplay({
      range_type_name: 'DHCP Scope',
      dhcp_expires_at: '2999-01-01T00:00:00Z'
    }).addressType).toMatchObject({ label: 'dynamic DHCP', className: 'type-dynamic-dhcp' });
  });

  it('shows online retained DHCP lifecycle rows as rogue without a current lease row', () => {
    const display = ipLifecycleDisplay({
      range_type_name: 'DHCP Scope',
      status: 'dhcp',
      hostname: 'host',
      is_online: 1,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'rogue', className: 'type-rogue' });
  });

  it('does not show offline retained DHCP lifecycle rows as assigned without a current lease row', () => {
    const display = ipLifecycleDisplay({
      range_type_name: 'DHCP Scope',
      status: 'available',
      hostname: 'host',
      is_online: 0,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('available');
    expect(display.addressType).toBeNull();
  });

  it('shows DNS-owned hostnames in a DHCP scope as static DNS', () => {
    const display = ipLifecycleDisplay({
      range_type_name: 'DHCP Scope',
      status: 'available',
      hostname: 'printer.example.test',
      detection_source: 'dns',
      is_online: 1,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'static DNS', className: 'type-static-dns' });
  });

  it('uses the backing DNS flag when detection_source is stale', () => {
    const display = ipLifecycleDisplay({
      range_type_name: 'DHCP Scope',
      status: 'available',
      hostname: 'testerella.example.test',
      detection_source: 'scanner',
      has_static_dns: 1,
      is_online: 1,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'static DNS', className: 'type-static-dns' });
  });

  it('does not assign a Type for available addresses inside DHCP scopes', () => {
    const display = ipLifecycleDisplay({ range_type_name: 'DHCP Scope' });
    expect(display.status).toBe('available');
    expect(display.addressType).toBeNull();
  });

  it('keeps rogue status as in use with rogue Type', () => {
    const display = ipLifecycleDisplay({ is_rogue: 1, rogue_reason: 'unexpected host' });
    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'rogue', className: 'type-rogue' });
    expect(display.tooltip).toBe('unexpected host');
  });

  it('treats online available unassigned rows as rogue even when flags arrive as strings', () => {
    const display = ipLifecycleDisplay({
      status: 'available',
      is_online: '1',
      has_dhcp_reservation: '0',
      hostname: null,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'rogue', className: 'type-rogue' });
  });

  it('does not infer static DNS from a stale hostname without DNS ownership', () => {
    const display = ipLifecycleDisplay({
      status: 'dhcp',
      hostname: 'espressif',
      detection_source: 'scanner',
      has_static_dns: 0,
      is_online: 0,
      dhcp_expires_at: null
    });
    expect(display.status).toBe('available');
    expect(display.addressType).toBeNull();
  });

  it('shows online DHCP scope rows without active leases as rogue', () => {
    const display = ipLifecycleDisplayForDhcpRow({
      dhcp_assignment_type: null,
      lease_status: 'available',
      ip_lifecycle_status: 'available',
      is_online: 1,
      hostname: 'restored-prod-lease',
      mac_address: 'aa:bb:cc:dd:ee:ff',
      dhcp_expires_at: null,
      has_dhcp_reservation: 0,
      has_static_dns: 0
    });

    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: 'rogue', className: 'type-rogue' });
  });

  it('shows DHCP scope rows with active leases as dynamic DHCP', () => {
    const display = ipLifecycleDisplayForDhcpRow({
      dhcp_assignment_type: 'dynamic',
      lease_status: 'active',
      ip_lifecycle_status: 'dhcp',
      is_online: 1,
      expires_at: '2999-01-01T00:00:00Z'
    });

    expect(display.addressType).toMatchObject({ label: 'dynamic DHCP', className: 'type-dynamic-dhcp' });
  });
});

// This module is the client-side fallback for the server's computeIpView, used
// when a row arrives without address_type. It has to agree with the server, so
// these mirror server/tests/unit/models/ip-view.test.js.
describe('ipLifecycleDisplay: parity with the server projection', () => {
  it('shows system for an address the appliance itself holds', () => {
    expect(ipLifecycleDisplay({ is_online: 1, is_local_address: 1 }).addressType)
      .toMatchObject({ label: 'system' });
  });

  it('prefers system over a stored rogue flag', () => {
    expect(ipLifecycleDisplay({ is_online: 1, is_local_address: 1, is_rogue: 1 }).addressType)
      .toMatchObject({ label: 'system' });
  });

  it('does not call a DNS-claimed address rogue', () => {
    expect(ipLifecycleDisplay({ status: 'available', is_online: 1, has_static_dns: 1 }).addressType)
      .toMatchObject({ label: 'static DNS' });
  });

  it('still shows rogue for an online address nothing claims', () => {
    expect(ipLifecycleDisplay({ status: 'available', is_online: 1 }).addressType)
      .toMatchObject({ label: 'rogue' });
  });

  // Known divergence, deliberately pinned rather than fixed here. The server's
  // computeIpView defaults a missing status to 'available' and would label this
  // rogue. This fallback leaves it undefined and returns no type. Real rows
  // always carry a status, so it does not bite today.
  it('returns no address type when the row carries no status at all', () => {
    expect(ipLifecycleDisplay({ is_online: 1 }).addressType).toBeNull();
  });
});
