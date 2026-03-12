import { describe, it, expect } from 'vitest';
import { ipToLong, longToIp, parseCidr } from '../../../src/utils/ip.js';

// Client-side IP utils mirror server-side — these tests catch drift

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
});

describe('longToIp', () => {
  it('converts 0 to 0.0.0.0', () => {
    expect(longToIp(0)).toBe('0.0.0.0');
  });

  it('converts 4294967295 to 255.255.255.255', () => {
    expect(longToIp(4294967295)).toBe('255.255.255.255');
  });

  it('round-trips with ipToLong', () => {
    const ips = ['0.0.0.0', '10.0.0.1', '192.168.1.1', '255.255.255.255'];
    for (const ip of ips) {
      expect(longToIp(ipToLong(ip))).toBe(ip);
    }
  });
});

describe('parseCidr', () => {
  it('parses /24', () => {
    const result = parseCidr('192.168.1.0/24');
    expect(result.network).toBe('192.168.1.0');
    expect(result.broadcast).toBe('192.168.1.255');
    expect(result.firstUsable).toBe('192.168.1.1');
    expect(result.lastUsable).toBe('192.168.1.254');
  });

  it('parses /32', () => {
    const result = parseCidr('10.0.0.1/32');
    expect(result.network).toBe('10.0.0.1');
    expect(result.broadcast).toBe('10.0.0.1');
  });

  it('normalizes host bits', () => {
    const result = parseCidr('192.168.1.100/24');
    expect(result.network).toBe('192.168.1.0');
  });

  it('throws on invalid CIDR', () => {
    expect(() => parseCidr('not-a-cidr')).toThrow();
    expect(() => parseCidr('192.168.1.0/33')).toThrow();
  });
});
