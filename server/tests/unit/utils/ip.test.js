import { describe, it, expect } from 'vitest';
import {
  ipToLong, longToIp, parseCidr, isIpInSubnet, isIpInRange,
  normalizeCidr, rangesOverlap, cidrsOverlap, isSubnetOf,
  isValidIp, isValidCidr, canMergeCidrs, calculateSubnets,
  subtractCidr, applyNameTemplate, validateSupernet, ipRange
} from '../../../src/utils/ip.js';

// ── ipToLong / longToIp ──────────────────────────────────

describe('ipToLong', () => {
  it('converts 0.0.0.0', () => {
    expect(ipToLong('0.0.0.0')).toBe(0);
  });

  it('converts 255.255.255.255', () => {
    expect(ipToLong('255.255.255.255')).toBe(4294967295);
  });

  it('converts 192.168.1.1', () => {
    expect(ipToLong('192.168.1.1')).toBe(3232235777);
  });

  it('converts 10.0.0.1', () => {
    expect(ipToLong('10.0.0.1')).toBe(167772161);
  });

  it('converts 172.16.0.0', () => {
    expect(ipToLong('172.16.0.0')).toBe(2886729728);
  });

  it('throws on invalid IP', () => {
    expect(() => ipToLong('999.999.999.999')).toThrow('Invalid IP');
    expect(() => ipToLong('1.2.3')).toThrow('Invalid IP');
    expect(() => ipToLong('abc')).toThrow('Invalid IP');
    expect(() => ipToLong('1.2.3.4.5')).toThrow('Invalid IP');
    expect(() => ipToLong('-1.0.0.0')).toThrow('Invalid IP');
    expect(() => ipToLong('1.2.3.256')).toThrow('Invalid IP');
  });
});

describe('longToIp', () => {
  it('converts 0 to 0.0.0.0', () => {
    expect(longToIp(0)).toBe('0.0.0.0');
  });

  it('converts 4294967295 to 255.255.255.255', () => {
    expect(longToIp(4294967295)).toBe('255.255.255.255');
  });

  it('round-trips with ipToLong', () => {
    const ips = ['0.0.0.0', '10.0.0.1', '172.16.255.254', '192.168.1.1', '255.255.255.255'];
    for (const ip of ips) {
      expect(longToIp(ipToLong(ip))).toBe(ip);
    }
  });
});

// ── parseCidr ────────────────────────────────────────────

describe('parseCidr', () => {
  it('parses /24', () => {
    const result = parseCidr('192.168.1.0/24');
    expect(result.network).toBe('192.168.1.0');
    expect(result.broadcast).toBe('192.168.1.255');
    expect(result.prefix).toBe(24);
    expect(result.mask).toBe('255.255.255.0');
    expect(result.totalAddresses).toBe(256);
    expect(result.firstUsable).toBe('192.168.1.1');
    expect(result.lastUsable).toBe('192.168.1.254');
    expect(result.usableCount).toBe(254);
  });

  it('parses /32 (single host)', () => {
    const result = parseCidr('10.0.0.1/32');
    expect(result.network).toBe('10.0.0.1');
    expect(result.broadcast).toBe('10.0.0.1');
    expect(result.totalAddresses).toBe(1);
    expect(result.usableCount).toBe(1);
    expect(result.firstUsable).toBe('10.0.0.1');
    expect(result.lastUsable).toBe('10.0.0.1');
  });

  it('parses /31 (point-to-point)', () => {
    const result = parseCidr('10.0.0.0/31');
    expect(result.network).toBe('10.0.0.0');
    expect(result.broadcast).toBe('10.0.0.1');
    expect(result.totalAddresses).toBe(2);
    expect(result.usableCount).toBe(2);
    expect(result.firstUsable).toBe('10.0.0.0');
    expect(result.lastUsable).toBe('10.0.0.1');
  });

  it('parses /0', () => {
    const result = parseCidr('0.0.0.0/0');
    expect(result.network).toBe('0.0.0.0');
    expect(result.broadcast).toBe('255.255.255.255');
    expect(result.totalAddresses).toBe(4294967296);
  });

  it('parses /8 (class A)', () => {
    const result = parseCidr('10.0.0.0/8');
    expect(result.network).toBe('10.0.0.0');
    expect(result.broadcast).toBe('10.255.255.255');
    expect(result.mask).toBe('255.0.0.0');
    expect(result.totalAddresses).toBe(16777216);
  });

  it('normalizes host bits to network', () => {
    const result = parseCidr('192.168.1.100/24');
    expect(result.network).toBe('192.168.1.0');
  });

  it('throws on invalid CIDR', () => {
    expect(() => parseCidr('not-a-cidr')).toThrow();
    expect(() => parseCidr('192.168.1.0')).toThrow(); // missing prefix
    expect(() => parseCidr('192.168.1.0/33')).toThrow('Invalid prefix');
  });
});

// ── isIpInSubnet / isIpInRange ───────────────────────────

describe('isIpInSubnet', () => {
  it('returns true for IP within subnet', () => {
    expect(isIpInSubnet('192.168.1.100', '192.168.1.0/24')).toBe(true);
  });

  it('returns true for network address', () => {
    expect(isIpInSubnet('192.168.1.0', '192.168.1.0/24')).toBe(true);
  });

  it('returns true for broadcast address', () => {
    expect(isIpInSubnet('192.168.1.255', '192.168.1.0/24')).toBe(true);
  });

  it('returns false for IP outside subnet', () => {
    expect(isIpInSubnet('192.168.2.1', '192.168.1.0/24')).toBe(false);
    expect(isIpInSubnet('10.0.0.1', '192.168.1.0/24')).toBe(false);
  });
});

describe('isIpInRange', () => {
  it('returns true for IP within range', () => {
    expect(isIpInRange('192.168.1.50', '192.168.1.10', '192.168.1.100')).toBe(true);
  });

  it('returns true for start of range', () => {
    expect(isIpInRange('192.168.1.10', '192.168.1.10', '192.168.1.100')).toBe(true);
  });

  it('returns true for end of range', () => {
    expect(isIpInRange('192.168.1.100', '192.168.1.10', '192.168.1.100')).toBe(true);
  });

  it('returns false for IP outside range', () => {
    expect(isIpInRange('192.168.1.9', '192.168.1.10', '192.168.1.100')).toBe(false);
    expect(isIpInRange('192.168.1.101', '192.168.1.10', '192.168.1.100')).toBe(false);
  });
});

// ── normalizeCidr ────────────────────────────────────────

describe('normalizeCidr', () => {
  it('strips host bits', () => {
    expect(normalizeCidr('192.168.1.50/24')).toBe('192.168.1.0/24');
    expect(normalizeCidr('10.1.2.3/8')).toBe('10.0.0.0/8');
  });

  it('returns same CIDR if already normalized', () => {
    expect(normalizeCidr('192.168.1.0/24')).toBe('192.168.1.0/24');
  });
});

// ── rangesOverlap ────────────────────────────────────────

describe('rangesOverlap', () => {
  it('detects overlapping ranges', () => {
    expect(rangesOverlap('192.168.1.10', '192.168.1.50', '192.168.1.30', '192.168.1.80')).toBe(true);
  });

  it('detects contained range', () => {
    expect(rangesOverlap('192.168.1.10', '192.168.1.100', '192.168.1.30', '192.168.1.50')).toBe(true);
  });

  it('detects exact boundary overlap', () => {
    expect(rangesOverlap('192.168.1.10', '192.168.1.50', '192.168.1.50', '192.168.1.80')).toBe(true);
  });

  it('detects non-overlapping ranges', () => {
    expect(rangesOverlap('192.168.1.10', '192.168.1.50', '192.168.1.51', '192.168.1.80')).toBe(false);
  });
});

// ── cidrsOverlap ─────────────────────────────────────────

describe('cidrsOverlap', () => {
  it('detects overlapping CIDRs', () => {
    expect(cidrsOverlap('192.168.1.0/24', '192.168.1.128/25')).toBe(true);
  });

  it('detects identical CIDRs', () => {
    expect(cidrsOverlap('10.0.0.0/24', '10.0.0.0/24')).toBe(true);
  });

  it('detects non-overlapping CIDRs', () => {
    expect(cidrsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
    expect(cidrsOverlap('10.0.0.0/8', '172.16.0.0/12')).toBe(false);
  });

  it('detects parent/child overlap', () => {
    expect(cidrsOverlap('10.0.0.0/8', '10.1.2.0/24')).toBe(true);
  });
});

// ── isSubnetOf ───────────────────────────────────────────

describe('isSubnetOf', () => {
  it('returns true for child within parent', () => {
    expect(isSubnetOf('192.168.1.0/24', '192.168.0.0/16')).toBe(true);
    expect(isSubnetOf('10.1.0.0/16', '10.0.0.0/8')).toBe(true);
  });

  it('returns false for same prefix', () => {
    expect(isSubnetOf('192.168.1.0/24', '192.168.1.0/24')).toBe(false);
  });

  it('returns false for non-contained subnet', () => {
    expect(isSubnetOf('192.168.2.0/24', '192.168.1.0/24')).toBe(false);
  });

  it('returns false for parent/child reversed', () => {
    expect(isSubnetOf('10.0.0.0/8', '10.1.0.0/16')).toBe(false);
  });
});

// ── isValidIp / isValidCidr ──────────────────────────────

describe('isValidIp', () => {
  it('returns true for valid IPs', () => {
    expect(isValidIp('0.0.0.0')).toBe(true);
    expect(isValidIp('192.168.1.1')).toBe(true);
    expect(isValidIp('255.255.255.255')).toBe(true);
  });

  it('returns false for invalid IPs', () => {
    expect(isValidIp('256.0.0.0')).toBe(false);
    expect(isValidIp('abc')).toBe(false);
    expect(isValidIp('')).toBe(false);
  });
});

describe('isValidCidr', () => {
  it('returns true for valid CIDRs', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('192.168.1.0/24')).toBe(true);
    expect(isValidCidr('0.0.0.0/0')).toBe(true);
  });

  it('returns false for invalid CIDRs', () => {
    expect(isValidCidr('10.0.0.0')).toBe(false);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('abc/24')).toBe(false);
  });
});

// ── calculateSubnets ─────────────────────────────────────

describe('calculateSubnets', () => {
  it('splits /24 into /25s', () => {
    const results = calculateSubnets('192.168.1.0/24', 25);
    expect(results).toHaveLength(2);
    expect(results[0].network).toBe('192.168.1.0');
    expect(results[1].network).toBe('192.168.1.128');
  });

  it('splits /24 into /26s', () => {
    const results = calculateSubnets('192.168.1.0/24', 26);
    expect(results).toHaveLength(4);
    expect(results[0].network).toBe('192.168.1.0');
    expect(results[1].network).toBe('192.168.1.64');
    expect(results[2].network).toBe('192.168.1.128');
    expect(results[3].network).toBe('192.168.1.192');
  });

  it('throws for invalid prefix', () => {
    expect(() => calculateSubnets('192.168.1.0/24', 24)).toThrow();
    expect(() => calculateSubnets('192.168.1.0/24', 33)).toThrow();
  });
});

// ── canMergeCidrs ────────────────────────────────────────

describe('canMergeCidrs', () => {
  it('merges two contiguous /25s into /24', () => {
    const result = canMergeCidrs(['192.168.1.0/25', '192.168.1.128/25']);
    expect(result.valid).toBe(true);
    expect(result.merged_cidr).toBe('192.168.1.0/24');
  });

  it('merges four contiguous /26s into /24', () => {
    const result = canMergeCidrs([
      '192.168.1.0/26', '192.168.1.64/26',
      '192.168.1.128/26', '192.168.1.192/26'
    ]);
    expect(result.valid).toBe(true);
    expect(result.merged_cidr).toBe('192.168.1.0/24');
  });

  it('rejects single subnet', () => {
    expect(canMergeCidrs(['192.168.1.0/24']).valid).toBe(false);
  });

  it('rejects non-contiguous subnets', () => {
    expect(canMergeCidrs(['192.168.1.0/25', '192.168.2.0/25']).valid).toBe(false);
  });

  it('rejects different prefix lengths', () => {
    expect(canMergeCidrs(['192.168.1.0/24', '192.168.2.0/25']).valid).toBe(false);
  });

  it('rejects non-power-of-2 count', () => {
    expect(canMergeCidrs([
      '192.168.1.0/26', '192.168.1.64/26', '192.168.1.128/26'
    ]).valid).toBe(false);
  });

  it('rejects misaligned subnets', () => {
    expect(canMergeCidrs(['192.168.1.128/25', '192.168.2.0/25']).valid).toBe(false);
  });
});

// ── subtractCidr ─────────────────────────────────────────

describe('subtractCidr', () => {
  it('subtracts /25 from /24 leaving one /25', () => {
    const remainder = subtractCidr('192.168.1.0/24', '192.168.1.0/25');
    expect(remainder).toEqual(['192.168.1.128/25']);
  });

  it('subtracts /26 from /24 leaving /25 + /26', () => {
    const remainder = subtractCidr('192.168.1.0/24', '192.168.1.0/26');
    expect(remainder).toHaveLength(2);
    expect(remainder).toContain('192.168.1.128/25');
    expect(remainder).toContain('192.168.1.64/26');
  });

  it('throws if child is outside parent', () => {
    expect(() => subtractCidr('192.168.1.0/24', '192.168.2.0/25')).toThrow('not within');
  });

  it('throws if child prefix is not longer', () => {
    expect(() => subtractCidr('192.168.1.0/24', '192.168.0.0/16')).toThrow();
  });
});

// ── validateSupernet ─────────────────────────────────────

describe('validateSupernet', () => {
  it('accepts RFC1918 range within boundary', () => {
    expect(validateSupernet('10.0.0.0/8').valid).toBe(true);
    expect(validateSupernet('192.168.1.0/24').valid).toBe(true);
    expect(validateSupernet('172.16.0.0/16').valid).toBe(true);
  });

  it('rejects CIDR crossing RFC1918 boundary', () => {
    const result = validateSupernet('10.0.0.0/7');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('extends beyond');
  });

  it('accepts public IP ranges', () => {
    expect(validateSupernet('8.8.8.0/24').valid).toBe(true);
  });
});

// ── applyNameTemplate ────────────────────────────────────

describe('applyNameTemplate', () => {
  it('replaces octet variables', () => {
    expect(applyNameTemplate('VLAN-%3', '192.168.10.0/24')).toBe('VLAN-10');
  });

  it('replaces bitmask variable', () => {
    expect(applyNameTemplate('Net-%1.%2.%3.%4/%bitmask', '10.1.2.0/24'))
      .toBe('Net-10.1.2.0/24');
  });
});

// ── ipRange ──────────────────────────────────────────────

describe('ipRange', () => {
  it('generates inclusive range', () => {
    const ips = [...ipRange('192.168.1.1', '192.168.1.3')];
    expect(ips).toEqual(['192.168.1.1', '192.168.1.2', '192.168.1.3']);
  });

  it('generates single IP range', () => {
    const ips = [...ipRange('10.0.0.1', '10.0.0.1')];
    expect(ips).toEqual(['10.0.0.1']);
  });
});
