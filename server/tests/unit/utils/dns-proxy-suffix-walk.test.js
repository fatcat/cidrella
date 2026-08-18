import { describe, it, expect, vi } from 'vitest';

// dns-proxy reaches for the DB and dnsmasq at import time. Stub both so this
// stays a unit test of the matching rule itself.
vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({ prepare: () => ({ pluck: () => ({ all: () => [], get: () => 0 }) }) }),
  getSetting: () => null,
  audit: () => {},
}));
vi.mock('../../../src/utils/dnsmasq.js', () => ({ atomicWrite: () => {}, restartDnsmasq: () => {} }));

const { domainSuffixes } = await import('../../../src/utils/dns-proxy.js');

/**
 * Duplicate-logic audit #12. The allowlist and the blocklist each carried their
 * own copy of the label walk. They agreed at the time, but nothing held them
 * together and the failure mode is silent: an allowlist that stops one level
 * earlier than the blocklist means a domain the operator explicitly permitted
 * is blocked, with nothing reporting why.
 *
 * This imports the REAL generator rather than restating the loop, which is the
 * whole point. A test that re-implements the walk passes no matter what the
 * module does.
 */
const walk = (name) => [...domainSuffixes(name)];

describe('#12: the shared label walk', () => {
  it('yields most specific first, down to the registrable name', () => {
    expect(walk('a.b.example.com')).toEqual([
      'a.b.example.com', 'b.example.com', 'example.com',
    ]);
  });

  it('a parent name covers its children', () => {
    expect(walk('sub.example.com')).toContain('example.com');
  });

  it('never yields a bare TLD, so allowlisting "com" cannot exempt the internet', () => {
    expect(walk('sub.example.com')).not.toContain('com');
    expect(walk('example.com')).toEqual(['example.com']);
  });

  it('a single label yields nothing at all', () => {
    expect(walk('localhost')).toEqual([]);
    expect(walk('com')).toEqual([]);
  });

  it('lowercases, so case cannot split the two matchers apart', () => {
    expect(walk('Sub.EXAMPLE.com')).toEqual(['sub.example.com', 'example.com']);
  });

  it('handles empty and nullish input without throwing', () => {
    for (const v of ['', null, undefined]) expect(walk(v)).toEqual([]);
  });
});
