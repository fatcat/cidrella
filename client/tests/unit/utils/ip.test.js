import { describe, it, expect } from 'vitest';
import {
  gatewayIpFromPosition,
  ipToLong,
  longToIp,
  normalizeGatewayPositionDefault,
  parseCidr,
  dhcpPoolScopeFor,
  divideGatewayDefault,
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

describe('dhcpPoolScopeFor (IPV6-48)', () => {
  const scopes = [
    { id: 1, address_family: 4, start_ip: '10.0.0.100', end_ip: '10.0.0.200' },
    {
      id: 2,
      address_family: 6,
      v6_mode: 'stateful',
      start_ip: '2001:db8::1000',
      end_ip: '2001:db8::1fff',
    },
    {
      id: 3,
      address_family: 6,
      v6_mode: 'slaac',
      start_ip: 'fd00:5::',
      end_ip: 'fd00:5::ffff:ffff:ffff:ffff',
    },
    { id: 4, address_family: 4, start_ip: 'garbage', end_ip: '10.9.9.9' },
  ];

  it('finds the pool of either family', () => {
    expect(dhcpPoolScopeFor(scopes, '10.0.0.150')?.id).toBe(1);
    expect(dhcpPoolScopeFor(scopes, '2001:db8::1500')?.id).toBe(2);
    expect(dhcpPoolScopeFor(scopes, '2001:DB8:0::1500')?.id).toBe(2);
  });

  it('is null outside every pool, for a SLAAC prefix, and for junk', () => {
    expect(dhcpPoolScopeFor(scopes, '10.0.0.50')).toBeNull();
    expect(dhcpPoolScopeFor(scopes, '2001:db8::2000')).toBeNull();
    expect(dhcpPoolScopeFor(scopes, 'fd00:5::10')).toBeNull();
    expect(dhcpPoolScopeFor(scopes, 'not an address')).toBeNull();
    expect(dhcpPoolScopeFor(null, '10.0.0.150')).toBeNull();
  });
});

describe('divideGatewayDefault (IPV6-50)', () => {
  it('keeps a custom gateway on the child that holds it, either family', () => {
    const v6 = { gateway_address: '2001:db8:0:1::fe' };
    expect(divideGatewayDefault(v6, '2001:db8:0:1::/64')).toEqual({
      policy: 'custom',
      address: '2001:db8:0:1::fe',
    });
    expect(divideGatewayDefault(v6, '2001:db8::/64')).toEqual({ policy: 'none', address: null });
    const v4 = { gateway_address: '10.0.1.254' };
    expect(divideGatewayDefault(v4, '10.0.1.0/24')).toEqual({
      policy: 'custom',
      address: '10.0.1.254',
    });
    expect(divideGatewayDefault(v4, '10.0.0.0/24')).toEqual({ policy: 'none', address: null });
    expect(divideGatewayDefault({}, '10.0.0.0/24')).toEqual({ policy: 'none', address: null });
  });
});
