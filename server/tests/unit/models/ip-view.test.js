import { describe, it, expect } from 'vitest';
import { computeIpView, ADDRESS_TYPE } from '../../../src/models/ip-view.js';

// computeIpView decides the label on every row of the Networks table. It is a
// pure function of one row, so it is cheap to pin down.
//
function view(row) {
  return computeIpView({
    ip_address: '10.0.1.50', allocation_state: 'unassigned', ...row
  });
}

describe('computeIpView: canonical allocation', () => {
  it('labels an online unclaimed address rogue', () => {
    expect(view({ is_online: 1 }).address_type).toBe(ADDRESS_TYPE.ROGUE);
  });

  it('labels a canonical static DNS allocation', () => {
    expect(view({ is_online: 1, allocation_state: 'static_dns' }).address_type)
      .toBe(ADDRESS_TYPE.STATIC_DNS);
  });

  it('does not infer allocation from protocol-shaped compatibility facts', () => {
    expect(view({ is_online: 1, has_static_dns: 1, has_dhcp_reservation: 1 }).address_type)
      .toBe(ADDRESS_TYPE.ROGUE);
  });

  it('keeps allocation type separate from a reported address conflict', () => {
    const row = view({
      is_online: 1,
      is_rogue: 1,
      rogue_reason: 'MAC mismatch (expected aa:bb:cc:dd:ee:ff, got 11:22:33:44:55:66)',
      allocation_state: 'static_dns',
    });
    expect(row.address_type).toBe(ADDRESS_TYPE.STATIC_DNS);
    expect(row.address_conflict).toBe(true);
    expect(row.address_conflict_reason).toContain('MAC mismatch');
  });

  it('maps static and dynamic DHCP allocations directly', () => {
    expect(view({ is_online: 1, allocation_state: 'static_dhcp' }).address_type)
      .toBe(ADDRESS_TYPE.RESERVED_DHCP);
    expect(view({ is_online: 1, allocation_state: 'dynamic_dhcp' }).address_type)
      .toBe(ADDRESS_TYPE.DYNAMIC_DHCP);
  });

  it('maps system and gateway allocations directly', () => {
    expect(view({ is_online: 1, allocation_state: 'gateway' }).address_type).toBe(ADDRESS_TYPE.GATEWAY);
    expect(view({ is_online: 1, allocation_state: 'system' }).address_type).toBe(ADDRESS_TYPE.SYSTEM);
  });

  it('an offline unclaimed address is not rogue, it is just available', () => {
    expect(view({ is_online: 0 }).address_type).toBeNull();
  });
});
