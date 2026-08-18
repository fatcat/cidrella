import { describe, it, expect } from 'vitest';
import {
  parseIp, canonicalizeIp, sortKey, addressFamily,
  isValidIp, isValidIpv6, IPV4_BITS, IPV6_BITS
} from '../../../src/utils/address.js';
import { ipToLong, longToIp } from '../../../src/utils/ip.js';

describe('parseIp', () => {
  it('parses dotted-quad', () => {
    expect(parseIp('10.0.0.1')).toEqual({ value: 0x0a000001n, bits: 32, zoneId: null });
    expect(parseIp('0.0.0.0').value).toBe(0n);
    expect(parseIp('255.255.255.255').value).toBe(0xffffffffn);
  });

  it('accepts leading zeros, matching the GeoIP allowlist rule', () => {
    // Deliberate. canonicalizeIp collapses the spelling, which is how the
    // allowlist makes UNIQUE(value) mean "unique network" not "unique
    // spelling". url-guard.js keeps a stricter parser for the security path.
    expect(canonicalizeIp('010.0.0.0')).toBe('10.0.0.0');
  });

  it('rejects malformed v4', () => {
    for (const s of ['10.0.0.256', '10.0.0', '10.0.0.1.5', '10.0.0.-1', '']) {
      expect(parseIp(s), s).toBeNull();
    }
  });

  it('parses v6 and folds case', () => {
    expect(parseIp('2001:DB8::1').value).toBe(parseIp('2001:db8::1').value);
    expect(parseIp('::').value).toBe(0n);
    expect(parseIp('::1').value).toBe(1n);
  });

  it('allows exactly one "::"', () => {
    expect(parseIp('1::2::3')).toBeNull();
    expect(parseIp(':::')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
  });

  it('strips a zone id and reports it separately', () => {
    expect(parseIp('fe80::1%eth0')).toEqual({ value: parseIp('fe80::1').value, bits: 128, zoneId: 'eth0' });
    expect(parseIp('fe80::1%')).toBeNull();
    // A zone id on a v4 literal is meaningless, so it is refused rather than
    // quietly ignored.
    expect(parseIp('10.0.0.1%eth0')).toBeNull();
  });

  it('refuses a zone id when the option is off', () => {
    expect(parseIp('fe80::1%eth0', { zoneId: false })).toBeNull();
    expect(parseIp('fe80::1', { zoneId: false })).not.toBeNull();
  });
});

describe('parseIp: IPv4-mapped addresses', () => {
  // This is the case that actually bites: Node hands back '::ffff:127.0.0.1'
  // for a v4 peer on a dual-stack socket. Folding it to v4 keeps one host from
  // occupying two rows.
  it('folds ::ffff:a.b.c.d down to v4', () => {
    const m = parseIp('::ffff:10.0.0.1');
    expect(m).toEqual({ value: 0x0a000001n, bits: IPV4_BITS, zoneId: null });
    expect(canonicalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(addressFamily('::ffff:10.0.0.1')).toBe(4);
  });

  it('folds the all-hex spelling of a mapped address too', () => {
    expect(canonicalizeIp('::ffff:c0a8:101')).toBe('192.168.1.1');
  });

  it('leaves ::ffff:... alone when mapV4 is off', () => {
    expect(parseIp('::ffff:10.0.0.1', { mapV4: false, embeddedV4: false })).toBeNull();
    expect(parseIp('::ffff:c0a8:101', { mapV4: false, embeddedV4: false }).bits).toBe(IPV6_BITS);
  });

  it('does NOT fold the deprecated IPv4-compatible form, which is a real v6 address', () => {
    // ::0.0.0.1 and ::1 are the same 128-bit value, so it must stay v6.
    expect(canonicalizeIp('::0.0.0.1')).toBe('::1');
    expect(addressFamily('::0.0.0.1')).toBe(6);
  });

  it('parses an embedded v4 tail in a non-mapped prefix', () => {
    expect(canonicalizeIp('2001:db8::192.168.1.1')).toBe('2001:db8::c0a8:101');
  });
});

describe('formatIp: RFC 5952', () => {
  it('compresses the longest zero run', () => {
    expect(canonicalizeIp('2001:db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalizeIp('0:0:0:0:0:0:0:0')).toBe('::');
  });

  it('does not compress a single zero group', () => {
    // The >= 2 threshold. A lone zero group stays spelled out.
    expect(canonicalizeIp('1:2:3:4:5:0:7:8')).toBe('1:2:3:4:5:0:7:8');
  });

  it('picks the leftmost run on a tie (s4.2.3)', () => {
    expect(canonicalizeIp('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
  });

  it('compresses the longest run when runs differ', () => {
    expect(canonicalizeIp('1:0:0:0:2:0:0:3')).toBe('1::2:0:0:3');
  });

  it('round-trips every canonical form back to itself', () => {
    for (const s of ['::', '::1', '2001:db8::1', '1:2:3:4:5:6:7:8',
      '1:2:3:4:5:0:7:8', '1::2:0:0:3:4', 'fe80::1', '10.0.0.1', '0.0.0.0']) {
      expect(canonicalizeIp(canonicalizeIp(s)), s).toBe(canonicalizeIp(s));
    }
  });
});

describe('addressFamily / validators', () => {
  it('classifies both families and rejects junk', () => {
    expect(addressFamily('10.0.0.1')).toBe(4);
    expect(addressFamily('2001:db8::1')).toBe(6);
    expect(addressFamily('not-an-ip')).toBeNull();
    expect(addressFamily(null)).toBeNull();
    expect(addressFamily(undefined)).toBeNull();
    expect(addressFamily(12345)).toBeNull();
  });

  it('isValidIp accepts both, isValidIpv6 only v6', () => {
    expect(isValidIp('10.0.0.1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp('10.0.0.256')).toBe(false);
    expect(isValidIpv6('2001:db8::1')).toBe(true);
    expect(isValidIpv6('10.0.0.1')).toBe(false);
  });
});

describe('sortKey', () => {
  it('is fixed width so byte order equals numeric order', () => {
    const keys = ['10.0.0.1', '2001:db8::1', '::1'].map(sortKey);
    expect(new Set(keys.map(k => k.length)).size).toBe(1);
    expect(keys[0]).toHaveLength(33);
  });

  it('orders v4 numerically, not lexically', () => {
    // The bug a plain string sort gives: '9.x' after '10.x'.
    const sorted = ['10.0.0.2', '9.255.255.255', '10.0.0.1']
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    expect(sorted).toEqual(['9.255.255.255', '10.0.0.1', '10.0.0.2']);
  });

  it('orders v6 numerically', () => {
    const sorted = ['2001:db8::10', '2001:db8::2', '::1']
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    expect(sorted).toEqual(['::1', '2001:db8::2', '2001:db8::10']);
  });

  it('keeps the families apart rather than interleaving', () => {
    const sorted = ['2001:db8::1', '10.0.0.1', '::1', '255.255.255.255']
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    expect(sorted).toEqual(['10.0.0.1', '255.255.255.255', '::1', '2001:db8::1']);
  });

  it('returns null for junk so callers must decide what to store', () => {
    expect(sortKey('not-an-ip')).toBeNull();
    expect(sortKey('')).toBeNull();
  });
});

describe('the v4-only helpers in ip.js stay v4-only', () => {
  // They are not built on address.js. The contract is that they refuse a v6
  // string loudly instead of truncating it to something plausible.
  it('ipToLong throws on a v6 address', () => {
    expect(() => ipToLong('2001:db8::1')).toThrow(/Invalid IP address/);
    expect(() => ipToLong('::1')).toThrow(/Invalid IP address/);
    expect(() => ipToLong('::ffff:10.0.0.1')).toThrow(/Invalid IP address/);
  });

  it('still round-trips v4', () => {
    expect(longToIp(ipToLong('10.0.0.1'))).toBe('10.0.0.1');
  });

  it('agrees with address.js on every v4 address it accepts', () => {
    for (const s of ['0.0.0.0', '10.0.0.1', '192.168.1.1', '255.255.255.255']) {
      expect(BigInt(ipToLong(s)), s).toBe(parseIp(s).value);
    }
  });
});
