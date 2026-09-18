/**
 * The IPv6-aware siblings in utils/ip.js. The IPv4 helpers keep their exact
 * messages (dhcp-pool-cidr-validators.test.js pins them); these add the
 * other family and the switch.
 */
import { describe, expect, it } from 'vitest';
import {
  IPV6_DISABLED_MESSAGE,
  networkValidationError,
  dhcpPoolErrorForNetwork,
  dhcpPoolError,
  maxPrefixFor,
  cidrFamily,
  dhcpV6ModesFor,
  gatewayIpFromPosition,
} from '../../../src/utils/ip.js';

describe('networkValidationError', () => {
  it('matches cidrValidationError for IPv4', () => {
    expect(networkValidationError('')).toBeNull();
    expect(networkValidationError('10.0.0.0/24')).toBeNull();
    expect(networkValidationError('10.0.0.0/33')).toBe('Invalid CIDR notation');
    expect(networkValidationError('10.0.0.0/7', { supernet: true })).toMatch(/extends beyond/);
  });

  it('refuses an IPv6 network with the server message while the switch is off', () => {
    expect(networkValidationError('fd00:1234::/48')).toBe(IPV6_DISABLED_MESSAGE);
    expect(networkValidationError('fd00:1234::/48', { ipv6: false, supernet: true })).toBe(
      IPV6_DISABLED_MESSAGE,
    );
  });

  it('accepts an IPv6 network when the switch is on and still applies the bounds rule', () => {
    expect(networkValidationError('fd00:1234::/48', { ipv6: true })).toBeNull();
    expect(networkValidationError('2001:db8::/129', { ipv6: true })).toBe('Invalid CIDR notation');
    expect(networkValidationError('fc00::/6', { ipv6: true, supernet: true })).toMatch(
      /extends beyond/,
    );
  });
});

describe('family helpers', () => {
  it('report the prefix bound and family per CIDR', () => {
    expect(maxPrefixFor('10.0.0.0/24')).toBe(32);
    expect(maxPrefixFor('fd00::/64')).toBe(128);
    expect(maxPrefixFor('nonsense')).toBe(32);
    expect(cidrFamily('10.0.0.0/24')).toBe(4);
    expect(cidrFamily('fd00::/64')).toBe(6);
    expect(cidrFamily('')).toBeNull();
  });

  it('allow the SLAAC modes on a /64 only', () => {
    expect(dhcpV6ModesFor(64)).toEqual(['slaac', 'stateless', 'stateful']);
    expect(dhcpV6ModesFor(56)).toEqual(['stateful']);
    expect(dhcpV6ModesFor('64')).toEqual(['slaac', 'stateless', 'stateful']);
  });

  it('names the gateway position for either family', () => {
    expect(gatewayIpFromPosition('10.0.0.0/24', 'first')).toBe('10.0.0.1');
    expect(gatewayIpFromPosition('10.0.0.0/24', 'last')).toBe('10.0.0.254');
    expect(gatewayIpFromPosition('fd00:1::/64', 'first')).toBe('fd00:1::1');
    expect(gatewayIpFromPosition('fd00:1::/64', 'last')).toBe('fd00:1::ffff:ffff:ffff:ffff');
    expect(gatewayIpFromPosition('fd00:1::/64', 'none')).toBeNull();
  });
});

describe('dhcpPoolErrorForNetwork', () => {
  it('hands IPv4 pools to dhcpPoolError unchanged', () => {
    const args = ['10.0.0.999', '10.0.0.20', '10.0.0.0/24'];
    expect(dhcpPoolErrorForNetwork(...args)).toBe(dhcpPoolError(...args));
    expect(dhcpPoolErrorForNetwork('10.0.0.10', '10.0.0.20', '10.0.0.0/24')).toBeNull();
    expect(dhcpPoolErrorForNetwork('10.0.0.30', '10.0.0.20', null)).toBe(
      dhcpPoolError('10.0.0.30', '10.0.0.20', null),
    );
  });

  it('checks an IPv6 pool for shape, order and containment', () => {
    expect(dhcpPoolErrorForNetwork('', 'fd00:1::20', 'fd00:1::/64')).toBe(
      'Start IP and End IP are required',
    );
    expect(dhcpPoolErrorForNetwork('fd00:1::zz', 'fd00:1::20', 'fd00:1::/64')).toBe(
      'Start IP must be a valid IPv6 address',
    );
    expect(dhcpPoolErrorForNetwork('fd00:1::30', 'fd00:1::20', 'fd00:1::/64')).toBe(
      'Start IP must be less than or equal to End IP',
    );
    expect(dhcpPoolErrorForNetwork('fd00:2::10', 'fd00:2::20', 'fd00:1::/64')).toBe(
      'Start IP must be within usable range fd00:1::1 - fd00:1::ffff:ffff:ffff:ffff',
    );
    expect(
      dhcpPoolErrorForNetwork('fd00:1::1000', 'fd00:1::1fff', 'fd00:1::/64', {
        label: 'DHCP Scope',
      }),
    ).toBeNull();
  });
});
