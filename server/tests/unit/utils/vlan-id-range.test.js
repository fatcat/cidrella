import { describe, it, expect } from 'vitest';
import { vlanIdError, VLAN_ID_MIN, VLAN_ID_MAX } from '../../../src/utils/validation.js';

/**
 * One VLAN range, shared by the subnets routes and the vlans routes.
 *
 * routes/subnets.js accepted 0-4094 in three places while routes/vlans.js and
 * migration 014's CHECK constraint both require 1-4094. A subnet could
 * therefore hold vlan_id = 0 that no vlans row is permitted to exist for, and
 * detectVlanCollision guards with `vlanId == null`, which 0 passes, so those
 * subnets silently skipped collision detection too.
 *
 * See REVIEW.md, duplicate-logic audit #16.
 */
describe('vlanIdError', () => {
  it('rejects 0, which is what the subnets routes used to accept', () => {
    expect(vlanIdError(0)).toMatch(/1-4094/);
  });

  it('accepts the assignable range at both ends', () => {
    expect(vlanIdError(VLAN_ID_MIN)).toBeNull();
    expect(vlanIdError(VLAN_ID_MAX)).toBeNull();
    expect(vlanIdError(100)).toBeNull();
  });

  it('rejects the reserved and out-of-range values', () => {
    for (const bad of [-1, 4095, 4096, 99999]) {
      expect(vlanIdError(bad), String(bad)).toMatch(/1-4094/);
    }
  });

  it('rejects non-integers rather than coercing them', () => {
    for (const bad of ['100', 1.5, null, undefined, NaN, {}, []]) {
      expect(vlanIdError(bad), JSON.stringify(bad)).toMatch(/1-4094/);
    }
  });

  it('matches the range migration 014 enforces on the vlans table', () => {
    expect([VLAN_ID_MIN, VLAN_ID_MAX]).toEqual([1, 4094]);
  });
});
