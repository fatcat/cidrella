import { describe, it, expect } from 'vitest';
import { isValidIpOrCidr, parseCidrEntry, ipMatchesEntry, ipInAny, canonicalizeIpOrCidr } from '../../../src/utils/cidr-match.js';

describe('isValidIpOrCidr', () => {
  it('accepts IPv4 + IPv4 CIDR', () => {
    expect(isValidIpOrCidr('1.2.3.4')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true);
    expect(isValidIpOrCidr('192.168.1.0/24')).toBe(true);
  });
  it('accepts IPv6 + IPv6 CIDR', () => {
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
    expect(isValidIpOrCidr('::1')).toBe(true);
  });
  it('rejects garbage / out-of-range / bad prefix', () => {
    expect(isValidIpOrCidr('1.2.3.4.5')).toBe(false);
    expect(isValidIpOrCidr('256.0.0.1')).toBe(false);
    expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
    expect(isValidIpOrCidr('not-an-ip')).toBe(false);
    expect(isValidIpOrCidr('1.2.3.4/8/8')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
  });
});

describe('ipMatchesEntry (IPv4)', () => {
  it('matches within a CIDR and excludes outside', () => {
    const e = parseCidrEntry('10.0.0.0/8');
    expect(ipMatchesEntry('10.5.6.7', e)).toBe(true);
    expect(ipMatchesEntry('11.0.0.1', e)).toBe(false);
  });
  it('single IP is an exact (/32) match', () => {
    const e = parseCidrEntry('203.0.113.9');
    expect(ipMatchesEntry('203.0.113.9', e)).toBe(true);
    expect(ipMatchesEntry('203.0.113.10', e)).toBe(false);
  });
  it('/24 boundary', () => {
    const e = parseCidrEntry('192.168.1.0/24');
    expect(ipMatchesEntry('192.168.1.255', e)).toBe(true);
    expect(ipMatchesEntry('192.168.2.0', e)).toBe(false);
  });
});

describe('ipMatchesEntry (IPv6)', () => {
  it('matches within a v6 CIDR', () => {
    const e = parseCidrEntry('2001:db8::/32');
    expect(ipMatchesEntry('2001:db8:abcd::1', e)).toBe(true);
    expect(ipMatchesEntry('2001:db9::1', e)).toBe(false);
  });
  it('family mismatch never matches', () => {
    expect(ipMatchesEntry('1.2.3.4', parseCidrEntry('2001:db8::/32'))).toBe(false);
    expect(ipMatchesEntry('2001:db8::1', parseCidrEntry('10.0.0.0/8'))).toBe(false);
  });
});

describe('ipInAny', () => {
  const entries = ['10.0.0.0/8', '203.0.113.9', '2001:db8::/32'].map(parseCidrEntry);
  it('true when any entry matches, false otherwise', () => {
    expect(ipInAny('10.1.2.3', entries)).toBe(true);
    expect(ipInAny('203.0.113.9', entries)).toBe(true);
    expect(ipInAny('2001:db8::5', entries)).toBe(true);
    expect(ipInAny('8.8.8.8', entries)).toBe(false);
  });
  it('empty list → false', () => {
    expect(ipInAny('10.1.2.3', [])).toBe(false);
  });
});

describe('formatCidrEntry / canonicalizeIpOrCidr', () => {
  it('masks host bits off and keeps the prefix', () => {
    expect(canonicalizeIpOrCidr('10.5.5.5/8')).toBe('10.0.0.0/8');
    expect(canonicalizeIpOrCidr('192.168.1.77/24')).toBe('192.168.1.0/24');
  });
  it('bare IPs gain an explicit host prefix', () => {
    expect(canonicalizeIpOrCidr('8.8.8.8')).toBe('8.8.8.8/32');
    expect(canonicalizeIpOrCidr('::1')).toBe('::1/128');
  });
  it('normalizes IPv4 leading zeros', () => {
    expect(canonicalizeIpOrCidr('010.0.0.0/8')).toBe('10.0.0.0/8');
  });
  it('lowercases and RFC-5952-compresses IPv6', () => {
    expect(canonicalizeIpOrCidr('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1/128');
    expect(canonicalizeIpOrCidr('2001:db8::/32')).toBe('2001:db8::/32');
    // longest zero run wins; leftmost on tie
    expect(canonicalizeIpOrCidr('2001:0:0:1:0:0:0:1/128')).toBe('2001:0:0:1::1/128');
  });
  it('all-zero address compresses to ::', () => {
    expect(canonicalizeIpOrCidr('0:0:0:0:0:0:0:0/0')).toBe('::/0');
  });
  it('idempotent on already-canonical input', () => {
    for (const v of ['10.0.0.0/8', '8.8.8.8/32', '2001:db8::1/128']) {
      expect(canonicalizeIpOrCidr(v)).toBe(v);
    }
  });
  it('null on invalid input', () => {
    expect(canonicalizeIpOrCidr('not-an-ip')).toBeNull();
    expect(canonicalizeIpOrCidr('10.0.0.0/33')).toBeNull();
  });
});
