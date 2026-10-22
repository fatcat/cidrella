// Property tests for the address and CIDR helpers: fast-check generates
// addresses and networks of both families and checks rules that must hold for
// every one of them, where the example tests in address.test.js and
// cidr.test.js check chosen cases.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  IPV4_BITS,
  IPV6_BITS,
  V4_MAPPED_PREFIX as V4_MAPPED_FIRST,
  V4_MAPPED_LAST,
  canonicalizeIp,
  formatIp,
  parseIp,
  sortKey,
} from '../../../src/utils/address.js';
import {
  bigToAddress,
  isNetworkWithin,
  mergeNetworks,
  networkContains,
  networksOverlap,
  parseNetwork,
  splitNetwork,
  subtractNetwork,
  validateNetworkBounds,
} from '../../../src/utils/cidr.js';

const MAX_V4 = (1n << 32n) - 1n;
const MAX_V6 = (1n << 128n) - 1n;

const v4Value = fc.bigInt({ min: 0n, max: MAX_V4 });
const v6Value = fc
  .bigInt({ min: 0n, max: MAX_V6 })
  .filter((v) => v < V4_MAPPED_FIRST || v > V4_MAPPED_LAST);
// Zero runs are where IPv6 spelling goes wrong, so mix in values made of
// whole zero and nonzero groups as well as uniform random ones.
const v6Sparse = fc
  .array(fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 0xffff })), {
    minLength: 8,
    maxLength: 8,
  })
  .map((groups) => groups.reduce((v, g) => (v << 16n) + BigInt(g), 0n))
  .filter((v) => v < V4_MAPPED_FIRST || v > V4_MAPPED_LAST);
const v6Any = fc.oneof(v6Value, v6Sparse);

const family = fc.constantFrom(4, 6);
const bitsOf = (fam) => (fam === 4 ? IPV4_BITS : IPV6_BITS);
const valueOf = (fam) => (fam === 4 ? v4Value : v6Any);

// A network of either family: a random address and prefix, not normalized.
const network = family.chain((fam) =>
  fc.record({
    family: fc.constant(fam),
    value: valueOf(fam),
    prefix: fc.integer({ min: 0, max: bitsOf(fam) }),
  }),
);
const cidrOf = ({ family: fam, value, prefix }) => `${bigToAddress(value, fam)}/${prefix}`;

// An IPv6 network reaching into ::ffff:0:0/96 has children and addresses that
// reparse as IPv4, so validateNetworkBounds refuses it and no such network
// exists to split or subtract. Random values almost never land there, so the
// rule is checked on its own below.
function overlapsMapped(n) {
  if (n.family !== 6) return false;
  const net = parseNetwork(cidrOf(n));
  return net.networkBig <= V4_MAPPED_LAST && V4_MAPPED_FIRST <= net.lastBig;
}
const unmappedNetwork = network.filter((n) => !overlapsMapped(n));

// A parent and a child network inside it, at most 12 bits longer so the split
// and merge properties stay small.
const parentAndChild = unmappedNetwork
  .filter((n) => n.prefix < bitsOf(n.family))
  .chain((parent) =>
    fc
      .record({
        extra: fc.integer({ min: 1, max: Math.min(12, bitsOf(parent.family) - parent.prefix) }),
        offset: fc.bigInt({ min: 0n, max: MAX_V6 }),
      })
      .map(({ extra, offset }) => {
        const bits = bitsOf(parent.family);
        const net = parseNetwork(cidrOf(parent));
        const childPrefix = parent.prefix + extra;
        const childSize = 1n << BigInt(bits - childPrefix);
        const slots = 1n << BigInt(extra);
        const child = net.networkBig + (offset % slots) * childSize;
        return {
          parent: net.cidr,
          child: `${bigToAddress(child, parent.family)}/${childPrefix}`,
        };
      }),
  );

// Expand an IPv6 value to eight groups with random zero padding and case, the
// spellings people paste that must all canonicalize to one string.
function looseV6(value, pads, upper) {
  const groups = [];
  for (let shift = 112n, i = 0; shift >= 0n; shift -= 16n, i++) {
    let g = ((value >> shift) & 0xffffn).toString(16);
    if (pads[i]) g = g.padStart(4, '0');
    groups.push(upper[i] ? g.toUpperCase() : g);
  }
  return groups.join(':');
}

describe('address properties', () => {
  it('formats and parses back to the same IPv4 value', () => {
    fc.assert(
      fc.property(v4Value, (v) => {
        const parsed = parseIp(formatIp(v, IPV4_BITS));
        expect(parsed).toMatchObject({ value: v, bits: IPV4_BITS });
      }),
    );
  });

  it('formats and parses back to the same IPv6 value', () => {
    fc.assert(
      fc.property(v6Any, (v) => {
        const parsed = parseIp(formatIp(v, IPV6_BITS));
        expect(parsed).toMatchObject({ value: v, bits: IPV6_BITS });
      }),
    );
  });

  it('folds every IPv4-mapped IPv6 address to its IPv4 address', () => {
    fc.assert(
      fc.property(v4Value, (v) => {
        const v4 = formatIp(v, IPV4_BITS);
        expect(canonicalizeIp(`::ffff:${v4}`)).toBe(v4);
        expect(canonicalizeIp(looseV6(V4_MAPPED_FIRST + v, [], []))).toBe(v4);
      }),
    );
  });

  it('gives every spelling of an IPv6 address one canonical form', () => {
    fc.assert(
      fc.property(
        v6Any,
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (v, pads, upper) => {
          const canonical = formatIp(v, IPV6_BITS);
          expect(canonicalizeIp(looseV6(v, pads, upper))).toBe(canonical);
          expect(canonicalizeIp(canonical)).toBe(canonical);
          // RFC 5952: lowercase, at most one '::', no leading zeros in a group.
          expect(canonical).toBe(canonical.toLowerCase());
          expect(canonical.split('::').length).toBeLessThanOrEqual(2);
          for (const g of canonical.split(':')) expect(g).not.toMatch(/^0[0-9a-f]/);
        },
      ),
    );
  });

  it('sorts keys in numeric order with every IPv4 address before every IPv6 one', () => {
    const addr = family.chain((fam) =>
      valueOf(fam).map((value) => ({ fam, value, text: formatIp(value, bitsOf(fam)) })),
    );
    fc.assert(
      fc.property(addr, addr, (a, b) => {
        const byKey = Math.sign(sortKey(a.text).localeCompare(sortKey(b.text)));
        const expected =
          a.fam !== b.fam
            ? Math.sign(a.fam - b.fam)
            : a.value < b.value
              ? -1
              : a.value > b.value
                ? 1
                : 0;
        expect(byKey).toBe(expected);
      }),
    );
  });

  it('returns null or an address for any string, never throws', () => {
    const noise = fc.oneof(fc.string(), fc.stringMatching(/^[0-9a-fA-F:.%/]{0,45}$/));
    fc.assert(
      fc.property(noise, (s) => {
        const parsed = parseIp(s);
        if (parsed !== null) expect([IPV4_BITS, IPV6_BITS]).toContain(parsed.bits);
      }),
    );
  });
});

describe('network properties', () => {
  it('normalizes to an aligned network that holds the address it was given', () => {
    fc.assert(
      fc.property(network, (n) => {
        const net = parseNetwork(cidrOf(n));
        const bits = bitsOf(n.family);
        const size = 1n << BigInt(bits - n.prefix);
        expect(net.family).toBe(n.family);
        expect(net.sizeBig).toBe(size);
        expect(net.networkBig % size).toBe(0n);
        expect(net.lastBig).toBe(net.networkBig + size - 1n);
        expect(parseNetwork(net.cidr).cidr).toBe(net.cidr);
        expect(networkContains(net.cidr, bigToAddress(n.value, n.family))).toBe(true);
      }),
    );
  });

  it('holds its first and last address and nothing either side of them', () => {
    fc.assert(
      fc.property(unmappedNetwork, (n) => {
        const net = parseNetwork(cidrOf(n));
        const max = n.family === 4 ? MAX_V4 : MAX_V6;
        expect(networkContains(net.cidr, net.first)).toBe(true);
        expect(networkContains(net.cidr, net.last)).toBe(true);
        if (net.networkBig > 0n) {
          const before = net.networkBig - 1n;
          // The address below an IPv6 network can be IPv4-mapped, which parses
          // as IPv4 and is outside an IPv6 network for that reason too.
          expect(networkContains(net.cidr, bigToAddress(before, n.family))).toBe(false);
        }
        if (net.lastBig < max) {
          expect(networkContains(net.cidr, bigToAddress(net.lastBig + 1n, n.family))).toBe(false);
        }
      }),
    );
  });

  it('never puts an address of one family inside a network of the other', () => {
    fc.assert(
      fc.property(network, (n) => {
        const net = parseNetwork(cidrOf(n));
        const other = n.family === 4 ? formatIp(1n, IPV6_BITS) : '10.0.0.1';
        expect(networkContains(net.cidr, other)).toBe(false);
      }),
    );
  });

  it('agrees with interval arithmetic on overlap and is symmetric', () => {
    fc.assert(
      fc.property(network, network, (a, b) => {
        const na = parseNetwork(cidrOf(a));
        const nb = parseNetwork(cidrOf(b));
        const expected =
          na.family === nb.family && na.networkBig <= nb.lastBig && nb.networkBig <= na.lastBig;
        expect(networksOverlap(na.cidr, nb.cidr)).toBe(expected);
        expect(networksOverlap(nb.cidr, na.cidr)).toBe(expected);
      }),
    );
  });

  it('refuses exactly the IPv6 networks that reach into ::ffff:0:0/96', () => {
    // Prefixes 80 to 128 around the mapped range, where random values never go.
    // Each is written as its network address: a prefix under 96 then lies
    // below the mapped range and stays IPv6, where an address inside it would
    // be read as IPv4 with a prefix parseNetwork refuses.
    const nearMapped = fc
      .record({
        value: fc.bigInt({ min: V4_MAPPED_FIRST - (1n << 40n), max: V4_MAPPED_LAST + (1n << 40n) }),
        prefix: fc.integer({ min: 80, max: IPV6_BITS }),
      })
      .map(({ value, prefix }) => ({
        family: 6,
        value: value & ~((1n << BigInt(IPV6_BITS - prefix)) - 1n),
        prefix,
      }));
    fc.assert(
      fc.property(fc.oneof(network, nearMapped), (n) => {
        const net = parseNetwork(cidrOf(n));
        if (net.family !== 6) return;
        const { valid } = validateNetworkBounds(net.cidr);
        if (overlapsMapped(n)) expect(valid).toBe(false);
        // Outside the mapped range only the reserved-range rule refuses.
        else if (!valid) expect(validateNetworkBounds(net.cidr).error).not.toMatch(/IPv4-mapped/);
      }),
    );
  });

  it.each([
    ['::fffe:0:0/95', false],
    ['::/64', false],
    ['::/0', false],
    ['2600::/12', true],
    // A mapped network folds to its IPv4 block, which is fine.
    ['::ffff:10.0.0.0/120', true],
  ])('validates %s as %s', (cidr, valid) => {
    expect(validateNetworkBounds(cidr).valid).toBe(valid);
  });

  it('puts a child inside its parent', () => {
    fc.assert(
      fc.property(parentAndChild, ({ parent, child }) => {
        expect(isNetworkWithin(child, parent)).toBe(true);
        expect(isNetworkWithin(parent, child)).toBe(false);
        expect(networksOverlap(parent, child)).toBe(true);
      }),
    );
  });

  it('subtracts a child as disjoint blocks that cover the rest of the parent', () => {
    fc.assert(
      fc.property(parentAndChild, ({ parent, child }) => {
        const p = parseNetwork(parent);
        const c = parseNetwork(child);
        const rest = subtractNetwork(parent, child).map((cidr) => parseNetwork(cidr));
        expect(rest).toHaveLength(c.prefix - p.prefix);
        const blocks = [...rest, c].sort((x, y) =>
          x.networkBig < y.networkBig ? -1 : x.networkBig > y.networkBig ? 1 : 0,
        );
        expect(blocks[0].networkBig).toBe(p.networkBig);
        expect(blocks[blocks.length - 1].lastBig).toBe(p.lastBig);
        for (let i = 1; i < blocks.length; i++) {
          expect(blocks[i].networkBig).toBe(blocks[i - 1].lastBig + 1n);
        }
        expect(mergeNetworks(blocks.map((b) => b.cidr))).toEqual({
          valid: true,
          merged_cidr: p.cidr,
        });
      }),
    );
  });

  it('splits a network into children that merge back into it', () => {
    const smallSplit = parentAndChild.filter(
      ({ parent, child }) => parseNetwork(child).prefix - parseNetwork(parent).prefix <= 6,
    );
    fc.assert(
      fc.property(smallSplit, ({ parent, child }) => {
        const children = splitNetwork(parent, parseNetwork(child).prefix);
        expect(children.map((c) => c.cidr)).toContain(parseNetwork(child).cidr);
        expect(mergeNetworks(children.map((c) => c.cidr))).toEqual({
          valid: true,
          merged_cidr: parseNetwork(parent).cidr,
        });
      }),
    );
  });
});
