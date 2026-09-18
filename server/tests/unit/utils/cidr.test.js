import { describe, expect, it } from 'vitest';
import {
  addressToBig,
  bigToAddress,
  parseNetwork,
  parseCidr,
  isValidNetwork,
  isValidCidr,
  normalizeNetwork,
  networkContains,
  networksOverlap,
  isNetworkWithin,
  subtractNetwork,
  splitNetwork,
  mergeNetworks,
  networkNameFromTemplate,
  validateNetworkBounds,
  RESERVED_RANGES,
} from '../../../src/utils/cidr.js';

/**
 * The family-generic CIDR layer: 128-bit arithmetic in BigInt, the base the
 * IPv6 work builds on. The IPv4 wrappers keep their own suite in ip.test.js;
 * here they are checked only where they must refuse or agree.
 */
describe('parseNetwork', () => {
  it('parses an IPv6 /64 with canonical spelling and BigInt sizes', () => {
    const net = parseNetwork('2001:DB8:0:1:abcd::5/64');
    expect(net).toMatchObject({
      family: 6,
      bits: 128,
      prefix: 64,
      network: '2001:db8:0:1::',
      cidr: '2001:db8:0:1::/64',
      mask: 'ffff:ffff:ffff:ffff::',
      first: '2001:db8:0:1::',
      last: '2001:db8:0:1:ffff:ffff:ffff:ffff',
      firstUsable: '2001:db8:0:1::1',
      lastUsable: '2001:db8:0:1:ffff:ffff:ffff:ffff',
    });
    expect(net.sizeBig).toBe(1n << 64n);
    // Only the subnet-router anycast address (the network address) is reserved.
    expect(net.usableBig).toBe((1n << 64n) - 1n);
    // A /64 does not fit a safe integer, so the Number views say so.
    expect(net.size).toBeNull();
    expect(net.usable).toBeNull();
    expect(net.broadcast).toBeUndefined();
    expect(net.networkLong).toBeUndefined();
    // API responses serialize parsed networks; the BigInt views stay off the wire.
    expect(() => JSON.stringify(net)).not.toThrow();
    expect(JSON.parse(JSON.stringify(net)).networkBig).toBeUndefined();
  });

  it('gives Number sizes when they fit, and reserves only the anycast address on IPv6', () => {
    const small = parseNetwork('fd00::/120');
    expect(small.size).toBe(256);
    expect(small.usable).toBe(255);
    expect([small.firstUsable, small.lastUsable]).toEqual(['fd00::1', 'fd00::ff']);
    expect(parseNetwork('fd00::1/128').usable).toBe(1);
    const pair = parseNetwork('fd00::/127');
    expect([pair.firstUsable, pair.lastUsable]).toEqual(['fd00::', 'fd00::1']);
    expect(parseNetwork('::/0').sizeBig).toBe(1n << 128n);
  });

  it('keeps the IPv4 contract intact on the same code path', () => {
    const net = parseNetwork('192.168.1.77/24');
    expect(net).toMatchObject({
      family: 4,
      bits: 32,
      network: '192.168.1.0',
      broadcast: '192.168.1.255',
      cidr: '192.168.1.0/24',
      mask: '255.255.255.0',
      firstUsable: '192.168.1.1',
      lastUsable: '192.168.1.254',
      networkLong: 3232235776,
      broadcastLong: 3232236031,
      totalAddresses: 256,
      usableCount: 254,
      size: 256,
      usable: 254,
    });
    expect(parseNetwork('10.0.0.0/31').usableCount).toBe(2);
    expect(parseNetwork('10.0.0.5/32').usableCount).toBe(1);
  });

  it('folds an IPv4-mapped IPv6 network to its IPv4 identity, as the address core does', () => {
    expect(parseNetwork('::ffff:10.0.0.7/120').cidr).toBe('10.0.0.0/24');
    expect(parseNetwork('::ffff:10.0.0.7/120').family).toBe(4);
    expect(parseNetwork('::ffff:10.0.0.7/128').cidr).toBe('10.0.0.7/32');
    // Shorter than the mapping itself reaches outside IPv4 space.
    expect(() => parseNetwork('::ffff:10.0.0.0/95')).toThrow(/Invalid prefix length: 95/);
  });

  it('rejects zone ids, bad prefixes and non-strings', () => {
    expect(() => parseNetwork('fe80::1%eth0/64')).toThrow(/Invalid CIDR notation/);
    expect(() => parseNetwork('fd00::/129')).toThrow(/Invalid prefix length: 129/);
    expect(() => parseNetwork('10.0.0.0/33')).toThrow(/Invalid prefix length: 33/);
    expect(() => parseNetwork('fd00::/')).toThrow(/Invalid CIDR notation/);
    expect(() => parseNetwork('fd00::')).toThrow(/Invalid CIDR notation/);
    expect(() => parseNetwork('fd00::/x')).toThrow(/Invalid CIDR notation/);
    expect(() => parseNetwork(null)).toThrow(/Invalid CIDR notation/);
    expect(isValidNetwork('fd00::/64')).toBe(true);
    expect(isValidNetwork('fd00:::/64')).toBe(false);
  });
});

describe('the IPv4 layer refuses IPv6 until the rest of the stack takes it', () => {
  it('parseCidr and isValidCidr say invalid for a v6 network', () => {
    expect(() => parseCidr('fd00::/64')).toThrow(/Invalid CIDR notation: fd00::\/64/);
    expect(isValidCidr('fd00::/64')).toBe(false);
    expect(isValidNetwork('fd00::/64')).toBe(true);
  });
});

describe('addressToBig and bigToAddress', () => {
  it('round-trip both families', () => {
    const v6 = addressToBig('2001:db8::1');
    expect(v6).toEqual({ value: 0x20010db8000000000000000000000001n, bits: 128, family: 6 });
    expect(bigToAddress(v6.value, 6)).toBe('2001:db8::1');
    const v4 = addressToBig('10.0.0.1');
    expect(v4).toEqual({ value: 167772161n, bits: 32, family: 4 });
    expect(bigToAddress(v4.value, 4)).toBe('10.0.0.1');
    expect(() => addressToBig('fe80::1%eth0')).toThrow(/Invalid IP address/);
    expect(() => addressToBig(7)).toThrow(/expected string/);
  });
});

describe('containment and overlap', () => {
  it('answers in both families and never across them', () => {
    expect(networkContains('2001:db8::/32', '2001:db8:ffff::1')).toBe(true);
    expect(networkContains('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(networkContains('2001:db8::/32', '10.0.0.1')).toBe(false);
    expect(networkContains('10.0.0.0/8', '2001:db8::1')).toBe(false);
    expect(() => networkContains('10.0.0.0/8', 'garbage')).toThrow(/Invalid IP address/);
    expect(networksOverlap('fd00::/8', 'fd12:3456::/32')).toBe(true);
    expect(networksOverlap('fd00::/8', 'fe80::/10')).toBe(false);
    expect(networksOverlap('fd00::/8', '10.0.0.0/8')).toBe(false);
    // Numerically these ranges coincide; the family keeps them apart.
    expect(networksOverlap('::/1', '10.0.0.0/8')).toBe(false);
    expect(networkContains('::/0', '10.0.0.1')).toBe(false);
    expect(isNetworkWithin('10.0.0.0/8', '::/0')).toBe(false);
    expect(isNetworkWithin('fd00:1::/48', 'fd00::/8')).toBe(true);
    expect(isNetworkWithin('fd00::/8', 'fd00::/8')).toBe(false);
    expect(isNetworkWithin('10.1.0.0/16', 'fd00::/8')).toBe(false);
    expect(normalizeNetwork('2001:db8::dead:beef/48')).toBe('2001:db8::/48');
  });
});

describe('split, merge and subtract on IPv6', () => {
  it('splits a /48 into /50s as parsed networks and caps the count', () => {
    const quarters = splitNetwork('2001:db8:1::/48', 50);
    expect(quarters.map((net) => net.cidr)).toEqual([
      '2001:db8:1::/50',
      '2001:db8:1:4000::/50',
      '2001:db8:1:8000::/50',
      '2001:db8:1:c000::/50',
    ]);
    expect(quarters[1].lastBig - quarters[1].networkBig + 1n).toBe(1n << 78n);
    expect(() => splitNetwork('2001:db8::/32', 64, 256)).toThrow(/more than 256 networks/);
    expect(() => splitNetwork('2001:db8::/32', 32)).toThrow(/must be larger than \/32 and <= 128/);
    expect(() => splitNetwork('2001:db8::/32', 129)).toThrow(/<= 128/);
  });

  it('merges an exact cover back to the parent and refuses everything else', () => {
    expect(mergeNetworks(['2001:db8:1:4000::/50', '2001:db8:1::/50'])).toEqual({
      valid: true,
      merged_cidr: '2001:db8:1::/49',
    });
    // Mixed prefix lengths that still cover one block.
    expect(
      mergeNetworks(['2001:db8:1::/50', '2001:db8:1:4000::/50', '2001:db8:1:8000::/49']),
    ).toEqual({ valid: true, merged_cidr: '2001:db8:1::/48' });
    expect(mergeNetworks(['2001:db8:1::/50', '2001:db8:1:8000::/50']).error).toBe(
      'Networks must be contiguous',
    );
    expect(mergeNetworks(['2001:db8:1:4000::/50', '2001:db8:1:8000::/50']).error).toBe(
      'Networks do not align to a valid CIDR boundary',
    );
    expect(
      mergeNetworks(['2001:db8:1::/50', '2001:db8:1:4000::/50', '2001:db8:1:8000::/50']).error,
    ).toBe('Network union size must be a power of 2');
    expect(mergeNetworks(['2001:db8::/32', '2001:db8:1::/48']).error).toBe(
      'Networks must not overlap',
    );
    expect(mergeNetworks(['10.0.0.0/25', 'fd00::/65']).error).toBe(
      'Networks must be the same address family',
    );
    expect(mergeNetworks(['fd00::/64']).error).toBe('Need at least 2 networks to merge');
    // Sizes past 2^53 still merge exactly.
    expect(mergeNetworks(['2001:db8::/33', '2001:db8:8000::/33'])).toEqual({
      valid: true,
      merged_cidr: '2001:db8::/32',
    });
  });

  it('subtracts a child as the fewest blocks', () => {
    const remainder = subtractNetwork('2001:db8::/32', '2001:db8:0:ffff::/64');
    expect(remainder).toHaveLength(32);
    expect(remainder[0]).toBe('2001:db8:8000::/33');
    expect(remainder.at(-1)).toBe('2001:db8:0:fffe::/64');
    // The remainder plus the child covers the parent exactly.
    expect(mergeNetworks([...remainder, '2001:db8:0:ffff::/64'])).toEqual({
      valid: true,
      merged_cidr: '2001:db8::/32',
    });
    expect(() => subtractNetwork('2001:db8::/32', '2001:db9::/48')).toThrow(/not within/);
    expect(() => subtractNetwork('2001:db8::/32', '10.0.0.0/24')).toThrow(/not within/);
    expect(() => subtractNetwork('2001:db8::/32', '2001:db8::/32')).toThrow(/longer than/);
  });
});

describe('names and bounds', () => {
  it('fills %1 to %4 with hextets on IPv6 and octets on IPv4', () => {
    expect(networkNameFromTemplate('net-%1-%2-%3-%4/%bitmask', '2001:db8:0:1::/64')).toBe(
      'net-2001-db8-0-1/64',
    );
    expect(networkNameFromTemplate('net-%1-%2-%3-%4/%bitmask', '10.20.30.40/24')).toBe(
      'net-10-20-30-0/24',
    );
  });

  it('joins IPv6 hextets with colons where the template dots its group placeholders', () => {
    expect(networkNameFromTemplate('%1.%2.%3.%4/%bitmask', 'fd00:9::/48')).toBe('fd00:9:0:0/48');
    expect(networkNameFromTemplate('%1.%2.%3.%4/%bitmask', '10.20.30.0/24')).toBe('10.20.30.0/24');
    // Dots that are not between two placeholders stay.
    expect(networkNameFromTemplate('lab.%1.%2/%bitmask', 'fd00:9::/48')).toBe('lab.fd00:9/48');
  });

  it('applies the reserved-range rule per family', () => {
    expect(validateNetworkBounds('fd00:1::/48')).toEqual({ valid: true });
    expect(validateNetworkBounds('fc00::/6').error).toMatch(/extends beyond Unique Local/);
    expect(validateNetworkBounds('fe80::/9').error).toMatch(
      /extends beyond Link-Local \(RFC4291\)/,
    );
    expect(validateNetworkBounds('2001:db8::/32')).toEqual({ valid: true });
    expect(validateNetworkBounds('2001:db8::/31').error).toMatch(/Documentation/);
    expect(validateNetworkBounds('2a00::/12')).toEqual({ valid: true });
    // IPv4 entries never judge an IPv6 network and vice versa.
    expect(validateNetworkBounds('10.0.0.0/7').error).toMatch(/RFC1918 Class A/);
    expect(RESERVED_RANGES.filter((r) => r.cidr.includes(':'))).toHaveLength(5);
  });
});
