import { describe, expect, it } from 'vitest';
import {
  ADDRESS_FAMILY,
  ALLOCATION_STATE,
  DISPLAY_STATUS,
  LIFECYCLE_SOURCE,
  canTransitionAllocation,
  displayStatusFor
} from '../../../src/models/ip-lifecycle.js';

describe('IP lifecycle contract', () => {
  it('defines the approved allocation states and address families', () => {
    expect(Object.values(ALLOCATION_STATE)).toEqual([
      'unassigned', 'reserved', 'static_dns', 'dynamic_dhcp', 'static_dhcp',
      'slaac', 'system', 'gateway', 'quarantined'
    ]);
    expect(Object.values(ADDRESS_FAMILY)).toEqual([4, 6]);
  });

  it('keeps administrative allocation mechanisms mutually exclusive', () => {
    expect(canTransitionAllocation('reserved', 'static_dns', LIFECYCLE_SOURCE.DNS)).toBe(true);
    expect(canTransitionAllocation('reserved', 'static_dhcp', LIFECYCLE_SOURCE.DHCP_RESERVATION)).toBe(true);
    expect(canTransitionAllocation('static_dns', 'static_dhcp', LIFECYCLE_SOURCE.DHCP_RESERVATION)).toBe(false);
    expect(canTransitionAllocation('static_dhcp', 'static_dns', LIFECYCLE_SOURCE.DNS)).toBe(false);
  });

  it('allows renewals and retirement only to the owning source', () => {
    expect(canTransitionAllocation('dynamic_dhcp', 'dynamic_dhcp', LIFECYCLE_SOURCE.DHCP_LEASE)).toBe(true);
    expect(canTransitionAllocation('dynamic_dhcp', 'unassigned', LIFECYCLE_SOURCE.DHCP_LEASE)).toBe(true);
    expect(canTransitionAllocation('dynamic_dhcp', 'unassigned', LIFECYCLE_SOURCE.DNS)).toBe(false);
    expect(canTransitionAllocation('slaac', 'unassigned', LIFECYCLE_SOURCE.SLAAC)).toBe(true);
  });

  it('derives display status from allocation and pool membership', () => {
    expect(displayStatusFor({ allocationState: 'unassigned' })).toBe(DISPLAY_STATUS.AVAILABLE);
    expect(displayStatusFor({ allocationState: 'unassigned', inDynamicPool: true })).toBe(DISPLAY_STATUS.DHCP_SCOPE);
    expect(displayStatusFor({ allocationState: 'reserved', inDynamicPool: true })).toBe(DISPLAY_STATUS.IN_USE);
  });
});

