import { describe, it, expect } from 'vitest';
import { dhcpPoolError, cidrValidationError } from '../../../src/utils/ip.js';

/**
 * Duplicate-logic audit #53 and #54.
 *
 * #53: three client DHCP-pool checks disagreed. The wizard applied the full
 * rule, the Configure dialog applied nothing, and ScopeDialog.save() checked
 * only that the fields were non-empty. A start after the end was blocked in one
 * and submitted from the other two.
 *
 * #54: three CIDR checks and only one ran validateSupernet, so 10.0.0.0/7 was
 * refused inline in the supernet dialog and became a generic server 400
 * elsewhere.
 */
describe('#53: dhcpPoolError', () => {
  const CIDR = '10.0.0.0/24';

  it('accepts a sane pool inside the subnet', () => {
    expect(dhcpPoolError('10.0.0.100', '10.0.0.200', CIDR)).toBeNull();
  });

  it('catches start after end, which two of the three sites used to submit', () => {
    expect(dhcpPoolError('10.0.0.200', '10.0.0.100', CIDR)).toMatch(/less than or equal/);
  });

  it('requires both ends', () => {
    expect(dhcpPoolError('', '10.0.0.200', CIDR)).toMatch(/required/);
    expect(dhcpPoolError('10.0.0.100', '', CIDR)).toMatch(/required/);
  });

  it('rejects malformed addresses', () => {
    expect(dhcpPoolError('10.0.0.999', '10.0.0.200', CIDR)).toMatch(/valid IPv4/);
    expect(dhcpPoolError('10.0.0.100', 'nope', CIDR)).toMatch(/valid IPv4/);
  });

  it('rejects a pool outside the subnet, naming the usable range', () => {
    expect(dhcpPoolError('10.0.1.5', '10.0.1.9', CIDR)).toMatch(/within usable range 10\.0\.0\.1 - 10\.0\.0\.254/);
    expect(dhcpPoolError('10.0.0.100', '10.0.1.9', CIDR)).toMatch(/End IP must be within usable range/);
  });

  it('excludes network and broadcast, which are not usable', () => {
    expect(dhcpPoolError('10.0.0.0', '10.0.0.200', CIDR)).toMatch(/within usable range/);
    expect(dhcpPoolError('10.0.0.100', '10.0.0.255', CIDR)).toMatch(/within usable range/);
  });

  it('still does shape and ordering checks when no subnet is known', () => {
    // ScopeDialog can be open before a subnet is picked. The half that was
    // missing everywhere is exactly this half.
    expect(dhcpPoolError('10.0.0.200', '10.0.0.100', null)).toMatch(/less than or equal/);
    expect(dhcpPoolError('10.0.0.100', '10.0.0.200', null)).toBeNull();
  });

  it('labels the fields the way the calling dialog does', () => {
    expect(dhcpPoolError('', '', CIDR, { label: 'DHCP Scope' })).toMatch(/DHCP Scope Start IP/);
    expect(dhcpPoolError('', '', CIDR)).toMatch(/^Start IP and End IP/);
  });
});

describe('#54: cidrValidationError', () => {
  it('passes a valid CIDR', () => {
    expect(cidrValidationError('10.0.0.0/24')).toBeNull();
    expect(cidrValidationError('192.168.1.0/24', { supernet: true })).toBeNull();
  });

  it('is quiet on empty input, so a blank field is not an error', () => {
    expect(cidrValidationError('')).toBeNull();
    expect(cidrValidationError(null)).toBeNull();
  });

  it('rejects malformed notation', () => {
    expect(cidrValidationError('not-a-cidr')).toBe('Invalid CIDR notation');
    expect(cidrValidationError('10.0.0.0/99')).toBe('Invalid CIDR notation');
  });

  it('applies the reserved-range rule ONLY in supernet mode', () => {
    // The exact case from the finding: 10.0.0.0/7 straddles the RFC1918 block.
    expect(cidrValidationError('10.0.0.0/7', { supernet: true })).toMatch(/RFC1918|extends beyond/);
    expect(cidrValidationError('10.0.0.0/7')).toBeNull();
  });
});
