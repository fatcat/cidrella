import { describe, expect, it } from 'vitest';
import {
  BLOCKED_IPV4_RANGES,
  BLOCKED_IPV6_RANGES,
  NON_GLOBAL_IPV4_RANGES,
  NON_GLOBAL_IPV6_RANGES,
  RESERVED_RANGES,
} from '../../../src/utils/special-ranges.js';
import { isGloballyRoutableCidr } from '../../../src/utils/ip.js';
import { isBlockedIpv4, isBlockedIpv6 } from '../../../src/utils/url-guard.js';
import { validateNetworkBounds } from '../../../src/utils/cidr.js';

// What the three modules held before they shared one table (2026-10-25).
const V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const V6_NON_GLOBAL = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
];
const V6_BLOCKED = [...V6_NON_GLOBAL, '64:ff9b::/96', '2001::/32', '2002::/16'];
const sorted = (list) => [...list].sort();

describe('special ranges', () => {
  it('derives the scan, outbound and reserved lists the modules used to carry', () => {
    expect(sorted(NON_GLOBAL_IPV4_RANGES)).toEqual(sorted(V4));
    expect(sorted(BLOCKED_IPV4_RANGES)).toEqual(sorted(V4));
    expect(sorted(NON_GLOBAL_IPV6_RANGES)).toEqual(sorted(V6_NON_GLOBAL));
    expect(sorted(BLOCKED_IPV6_RANGES)).toEqual(sorted(V6_BLOCKED));
    // Order matters here: the supernet check names the first range it overlaps.
    expect(RESERVED_RANGES.map((r) => r.cidr)).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16',
      '127.0.0.0/8',
      '224.0.0.0/4',
      '240.0.0.0/4',
      'fc00::/7',
      'fe80::/10',
      '::1/128',
      'ff00::/8',
      '2001:db8::/32',
    ]);
  });

  it('feeds every check, both families', () => {
    expect(isGloballyRoutableCidr('198.51.100.0/24')).toBe(false);
    expect(isGloballyRoutableCidr('8.8.8.0/24')).toBe(true);
    expect(isGloballyRoutableCidr('2001:db8:1::/48')).toBe(false);
    expect(isGloballyRoutableCidr('2600::/48')).toBe(true);
    expect(isBlockedIpv4('169.254.169.254')).toBe(true);
    expect(isBlockedIpv4('9.9.9.9')).toBe(false);
    expect(isBlockedIpv6('2002::1')).toBe(true);
    expect(isBlockedIpv6('2620:fe::fe')).toBe(false);
    expect(validateNetworkBounds('128.0.0.0/1').error).toMatch(/RFC1918 Class B/);
    expect(validateNetworkBounds('fe00::/7').error).toMatch(/Link-Local \(RFC4291\)/);
  });
});
