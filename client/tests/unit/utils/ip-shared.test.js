import { describe, expect, it } from 'vitest';
import * as shared from '@shared/cidr.js';
import * as clientIp from '../../../src/utils/ip.js';

/**
 * Duplicate-logic audit #3: the client and server CIDR helpers used to be two
 * modules that drifted (validation, /31 and /32, the return type of
 * calculateSubnets). They are one body now, server/src/utils/cidr.js, and
 * this file is the drift alarm: every shared name the client exports must be
 * the very same function object the server module exports. A client-local
 * fork, however faithful, fails the identity check.
 */
const SHARED = [
  'ipToLong',
  'longToIp',
  'parseCidr',
  'isIpInSubnet',
  'normalizeCidr',
  'RESERVED_RANGES',
  'validateSupernet',
  'applyNameTemplate',
  'canMergeCidrs',
  'calculateSubnets',
  'isValidIpv4',
  'isValidCidr',
  'isSubnetOf',
  'cidrsOverlap',
  'subtractCidr',
];

describe('client ip.js shares the server CIDR core', () => {
  it('re-exports every shared name as the same object', () => {
    for (const name of SHARED) {
      expect(clientIp[name], name).toBe(shared[name]);
    }
  });

  it('settles the contracts the two copies used to disagree on', () => {
    // Validation: no plausible number for garbage.
    expect(() => shared.ipToLong('999.1.1.1')).toThrow(/Invalid IP address/);
    expect(() => shared.ipToLong('1.2.3')).toThrow(/Invalid IP address/);
    expect(() => shared.ipToLong(null)).toThrow(/expected string/);
    // /31 and /32 per RFC 3021, and the fields the client copy omitted.
    const p2p = shared.parseCidr('10.0.0.0/31');
    expect([p2p.firstUsable, p2p.lastUsable, p2p.usableCount, p2p.mask]).toEqual([
      '10.0.0.0',
      '10.0.0.1',
      2,
      '255.255.255.254',
    ]);
    const host = shared.parseCidr('10.0.0.5/32');
    expect([host.firstUsable, host.lastUsable, host.usableCount]).toEqual([
      '10.0.0.5',
      '10.0.0.5',
      1,
    ]);
    // calculateSubnets returns parsed networks and throws on an impossible split.
    const halves = shared.calculateSubnets('10.0.0.0/24', 25);
    expect(halves.map((child) => `${child.network}/${child.prefix}`)).toEqual([
      '10.0.0.0/25',
      '10.0.0.128/25',
    ]);
    expect(() => shared.calculateSubnets('10.0.0.0/24', 24)).toThrow(/must be larger/);
    expect(() => shared.calculateSubnets('10.0.0.0/8', 30, 256)).toThrow(/more than 256/);
    // isIpInSubnet validates the address instead of answering false.
    expect(() => shared.isIpInSubnet('not-an-ip', '10.0.0.0/24')).toThrow(/Invalid IP address/);
    // Product wording, one vocabulary on both tiers.
    expect(shared.canMergeCidrs(['10.0.0.0/25', '10.0.1.0/25']).error).toBe(
      'Networks must be contiguous',
    );
    expect(shared.validateSupernet('10.0.0.0/7').error).toMatch(
      /extends beyond .* Supernet must be within/,
    );
  });
});
