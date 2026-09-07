import { describe, expect, it } from 'vitest';
import {
  ipLifecycleDisplay,
  ipLifecycleDisplayForDhcpRow
} from '../../../src/utils/ipLifecycleDisplay.js';

describe('ipLifecycleDisplay', () => {
  const cases = [
    ['static DNS', 'type-static-dns'],
    ['DHCP Reservation', 'type-reserved-dhcp'],
    ['dynamic DHCP', 'type-dynamic-dhcp'],
    ['IP Reservation', 'type-reserved'],
    ['system', 'type-system'],
    ['gateway', 'type-gateway'],
    ['SLAAC', 'type-slaac'],
    ['quarantined', 'type-quarantined'],
    ['rogue', 'type-rogue']
  ];

  it.each(cases)('formats the server-projected %s type', (address_type, className) => {
    const display = ipLifecycleDisplay({
      ip_display_status: 'in use',
      ip_status_severity: 'danger',
      address_type
    });

    expect(display.status).toBe('in use');
    expect(display.addressType).toMatchObject({ label: address_type, className });
  });

  it('renders the server-projected available state without a type', () => {
    expect(ipLifecycleDisplay({
      ip_display_status: 'available',
      ip_status_severity: 'secondary',
      address_type: null
    })).toMatchObject({ status: 'available', addressType: null });
  });

  it('renders the server-projected DHCP Scope state without a type', () => {
    expect(ipLifecycleDisplay({ ip_display_status: 'DHCP Scope', address_type: null }))
      .toMatchObject({ status: 'DHCP Scope', addressType: null });
  });

  it('preserves the server tooltip', () => {
    expect(ipLifecycleDisplay({
      ip_display_status: 'in use',
      address_type: 'quarantined',
      address_type_tooltip: 'two claims'
    }).tooltip).toBe('two claims');
  });

  it('formats an unknown future server type explicitly', () => {
    expect(ipLifecycleDisplay({ ip_display_status: 'in use', address_type: 'future state' }).addressType)
      .toMatchObject({ label: 'future state', className: 'type-unknown' });
  });

  it('does not infer availability or ownership from canonical or protocol facts', () => {
    const display = ipLifecycleDisplay({
      allocation_state: 'static_dns',
      status: 'assigned',
      has_dhcp_reservation: 1,
      has_static_dns: 1,
      is_online: 1,
      is_rogue: 1
    });

    expect(display).toMatchObject({ status: 'unknown', addressType: null });
  });
});

describe('ipLifecycleDisplayForDhcpRow', () => {
  it('uses the canonical display projection supplied by the server', () => {
    expect(ipLifecycleDisplayForDhcpRow({
      allocation_state: 'dynamic_dhcp',
      dhcp_assignment_type: 'dynamic',
      ip_display_status: 'in use',
      address_type: 'dynamic DHCP'
    }).addressType).toMatchObject({ label: 'dynamic DHCP' });
  });

  it('does not infer a type from the DHCP row shape', () => {
    const display = ipLifecycleDisplayForDhcpRow({
      allocation_state: 'unassigned',
      dhcp_assignment_type: 'reserved'
    });

    expect(display.status).toBe('unknown');
    expect(display.addressType).toBeNull();
  });
});
