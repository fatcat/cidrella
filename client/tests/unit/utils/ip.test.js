import { describe, it, expect } from 'vitest';
import {
  gatewayIpFromPosition,
  ipToLong,
  longToIp,
  normalizeGatewayPositionDefault,
  parseCidr,
} from '../../../src/utils/ip.js';

// Client-side IP utils mirror server-side. These tests catch drift

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

describe('ipToLong on bad input', () => {
  it('throws instead of returning a plausible number', () => {
    for (const bad of ['abc', '999.1.1.1', '1.2.3', '1.2.3.4.5', null, 42]) {
      expect(() => ipToLong(bad)).toThrow(/Invalid IP address/);
    }
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

  it('parses /32 as a single host and /31 as a point-to-point pair (RFC 3021)', () => {
    const host = parseCidr('10.0.0.1/32');
    expect(host.network).toBe('10.0.0.1');
    expect(host.broadcast).toBe('10.0.0.1');
    expect(host.firstUsable).toBe('10.0.0.1');
    expect(host.lastUsable).toBe('10.0.0.1');
    expect(host.usableCount).toBe(1);
    const pair = parseCidr('10.0.0.0/31');
    expect([pair.firstUsable, pair.lastUsable, pair.usableCount]).toEqual([
      '10.0.0.0',
      '10.0.0.1',
      2,
    ]);
    expect(parseCidr('192.168.1.0/24').mask).toBe('255.255.255.0');
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

describe('gatewayIpFromPosition', () => {
  it('uses allocatable addresses rather than the network or broadcast address', () => {
    expect(gatewayIpFromPosition('1.1.1.0/24', 'first')).toBe('1.1.1.1');
    expect(gatewayIpFromPosition('1.1.1.0/24', 'last')).toBe('1.1.1.254');
  });

  it('normalizes persisted defaults to the supported positions', () => {
    expect(normalizeGatewayPositionDefault('last')).toBe('last');
    expect(normalizeGatewayPositionDefault('first')).toBe('first');
    expect(normalizeGatewayPositionDefault(undefined)).toBe('first');
  });
});
