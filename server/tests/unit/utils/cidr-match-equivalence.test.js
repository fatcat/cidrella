import { describe, it, expect } from 'vitest';
import * as next from '../../../src/utils/cidr-match.js';
import * as prev from './fixtures/cidr-match-pre-address-refactor.js';

// Differential test for the address.js extraction.
//
// cidr-match.js used to carry its own parser and RFC 5952 formatter. Those moved
// into address.js, and cidr-match now calls them with a STRICT option set chosen
// to preserve the old semantics exactly. "Exactly" is a claim, and the GeoIP
// allowlist stores canonicalized values in the database, so a silent widening
// would change what an already-stored row means.
//
// The frozen pre-refactor copy in fixtures/ is the other half of the comparison.
// Do NOT refactor or tidy that file: its whole job is to be what the code used
// to do. If a deliberate behavior change is ever wanted here, delete this test
// in the same commit and say so in the release notes.
//
// The existing cidr-match.test.js does not cover the compression threshold or
// the strict/loose parsing modes: both survive mutation there. This one is
// mutation-tested against exactly those two branches.

const CASES = [
  // Plain v4, including the leading-zero spelling the allowlist relies on.
  '10.0.0.1', '0.0.0.0', '255.255.255.255', '010.0.0.0', '10.5.5.5',
  '10.0.0.256', '10.0.0', '10.0.0.1.5', '1.2.3.04',
  // v4 CIDR.
  '10.0.0.0/8', '10.5.5.5/8', '010.0.0.0/8', '8.8.8.8/32', '0.0.0.0/0',
  '10.0.0.0/33', '10.0.0.0/999', '10.0.0.0/', '10.0.0.0/x', '10.0.0.0/8/8',
  // v6 spellings that exercise the compression threshold from both sides.
  '::1', '::', '2001:db8::1', '2001:DB8:0:0:0:0:0:1',
  '2001:0:0:1:0:0:0:1', '1:2:3:4:5:6:7:8', '0:0:0:0:0:0:0:0',
  '1:0:0:2:0:0:0:3', '1:0:2:0:3:0:4:0', 'fe80:0:0:0:0:0:0:1',
  '2001:db8:0:0:1:0:0:1', 'a:0:0:b:0:0:0:c',
  // v6 CIDR.
  '2001:db8::/32', '2001:0DB8::/32', '::1/128', '::/0', '2001:db8::1/129',
  'fe80::/10', '2001:db8:abcd::/48',
  // Forms address.js accepts but cidr-match must keep refusing.
  '::ffff:10.0.0.1', '::ffff:c0a8:101', '2001:db8::192.168.1.1',
  'fe80::1%eth0', '10.0.0.1%eth0', '::ffff:10.0.0.1/128',
  // Malformed.
  '1::2::3', '2001:db8::1::2', ':::', '1:2:3:4:5:6:7:8:9', 'g::1',
  '', '   ', 'not-an-ip', '  10.0.0.1  ', ' 2001:db8::1 ',
];

const MATCH_PROBES = [
  '10.0.0.1', '10.255.255.255', '11.0.0.1', '2001:db8::1', '2001:db9::1',
  '::1', '::ffff:10.0.0.1', 'fe80::1', '192.168.1.1',
];

describe('cidr-match: equivalence with the pre-address.js implementation', () => {
  it('isValidIpOrCidr agrees on every fixture', () => {
    for (const c of CASES) {
      expect(next.isValidIpOrCidr(c), `isValidIpOrCidr(${JSON.stringify(c)})`)
        .toBe(prev.isValidIpOrCidr(c));
    }
  });

  it('canonicalizeIpOrCidr agrees on every fixture', () => {
    for (const c of CASES) {
      expect(next.canonicalizeIpOrCidr(c), `canonicalizeIpOrCidr(${JSON.stringify(c)})`)
        .toBe(prev.canonicalizeIpOrCidr(c));
    }
  });

  it('parseCidrEntry agrees on network, mask, bits and prefix', () => {
    for (const c of CASES) {
      const a = next.parseCidrEntry(c);
      const b = prev.parseCidrEntry(c);
      const label = `parseCidrEntry(${JSON.stringify(c)})`;
      if (b === null) { expect(a, label).toBeNull(); continue; }
      expect(a, label).not.toBeNull();
      expect(a.bits, `${label}.bits`).toBe(b.bits);
      expect(a.prefix, `${label}.prefix`).toBe(b.prefix);
      expect(a.network.toString(16), `${label}.network`).toBe(b.network.toString(16));
      expect(a.mask.toString(16), `${label}.mask`).toBe(b.mask.toString(16));
    }
  });

  it('ipMatchesEntry agrees for every probe against every valid entry', () => {
    let compared = 0;
    for (const c of CASES) {
      const entryNext = next.parseCidrEntry(c);
      const entryPrev = prev.parseCidrEntry(c);
      if (entryPrev === null) continue;
      for (const probe of MATCH_PROBES) {
        expect(next.ipMatchesEntry(probe, entryNext),
          `ipMatchesEntry(${probe}, ${JSON.stringify(c)})`)
          .toBe(prev.ipMatchesEntry(probe, entryPrev));
        compared++;
      }
    }
    // Guard against the fixture table silently emptying out and this passing
    // while comparing nothing.
    expect(compared).toBeGreaterThan(100);
  });

  it('the fixture table actually reaches both sides of the branches that matter', () => {
    // At least one address whose canonical form uses '::' compression.
    expect(CASES.some(c => (prev.canonicalizeIpOrCidr(c) || '').includes('::'))).toBe(true);
    // At least one v6 address with a SINGLE zero group, which must NOT compress.
    // This is the case that dies if the >= 2 threshold is wrong.
    expect(prev.canonicalizeIpOrCidr('1:2:3:4:5:0:7:8')).toBe('1:2:3:4:5:0:7:8/128');
    expect(next.canonicalizeIpOrCidr('1:2:3:4:5:0:7:8')).toBe('1:2:3:4:5:0:7:8/128');
    // At least one form the strict mode must refuse.
    expect(prev.isValidIpOrCidr('::ffff:10.0.0.1')).toBe(false);
    expect(next.isValidIpOrCidr('::ffff:10.0.0.1')).toBe(false);
  });
});
