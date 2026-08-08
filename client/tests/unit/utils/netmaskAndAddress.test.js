/**
 * Netmask/broadcast derivation and the single IPv4-shape predicate.
 *
 * #50: ScopeDialog.vue hand-rolled computeBroadcast and computeMask in a file
 * that already imports parseCidr and uses it sixty lines below. Neither copy
 * validated its input, and `parseInt(undefined)` is NaN, which slips straight
 * through a `p < 0 || p > 32` guard. The results are written into DHCP option 1
 * (subnet mask) and option 28 (broadcast), so a malformed subnet_cidr produced a
 * scope advertising a /32 mask instead of raising an error.
 *
 * #51: three IPv4-shape predicates with three strictness levels. The one in
 * resolveHostname.js decides whether an entry is already an address or needs a
 * DNS lookup, and it checked shape only, so "300.1.1.1" was passed through
 * untouched into a DHCP option value.
 *
 * See REVIEW.md, duplicate-logic audit #50 and #51.
 */
import { describe, it, expect } from 'vitest';
import { netmaskFor, parseCidr, isValidIpv4 } from '../../../src/utils/ip.js';

describe('netmaskFor', () => {
  it('derives the usual masks', () => {
    expect(netmaskFor(24)).toBe('255.255.255.0');
    expect(netmaskFor(16)).toBe('255.255.0.0');
    expect(netmaskFor(8)).toBe('255.0.0.0');
    expect(netmaskFor(30)).toBe('255.255.255.252');
    expect(netmaskFor(32)).toBe('255.255.255.255');
    expect(netmaskFor(0)).toBe('0.0.0.0');
  });

  it('refuses a prefix that is not a real prefix', () => {
    // The hand-rolled copies let NaN through: `NaN < 0 || NaN > 32` is false.
    for (const bad of [undefined, null, NaN, -1, 33, '', 'abc', 24.5]) {
      expect(netmaskFor(bad), `prefix ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('never yields a /32 mask for a malformed CIDR', () => {
    // The exact failure: '10.0.3.0' with no prefix produced 255.255.255.255.
    for (const bad of ['10.0.3.0', 'bogus/24', '10.0.3.0/', '']) {
      let out;
      try { out = netmaskFor(parseCidr(bad).prefix); } catch { out = null; }
      expect(out, `cidr ${JSON.stringify(bad)}`).not.toBe('255.255.255.255');
    }
  });

  it('parseCidr rejects what the hand-rolled versions silently accepted', () => {
    expect(() => parseCidr('10.0.3.0')).toThrow();
    expect(() => parseCidr('bogus/24')).toThrow();
  });
});

describe('isValidIpv4 as the single address predicate', () => {
  it('rejects out-of-range octets that a shape-only regex accepted', () => {
    // resolveHostname treated these as "already an address" and skipped the lookup.
    expect(isValidIpv4('300.1.1.1')).toBe(false);
    expect(isValidIpv4('256.0.0.1')).toBe(false);
    // and the NetworkDialogs inline regex accepted 4-digit octets
    expect(isValidIpv4('1234.1.1.1')).toBe(false);
  });

  it('still accepts real addresses', () => {
    for (const ip of ['10.0.3.1', '0.0.0.0', '255.255.255.255', '192.168.1.100']) {
      expect(isValidIpv4(ip), ip).toBe(true);
    }
  });
});
