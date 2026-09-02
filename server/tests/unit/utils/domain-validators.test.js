import { describe, it, expect } from 'vitest';
import { isValidDomain } from '../../../src/utils/ip.js';
import { isValidRecordName } from '../../../src/utils/dnsmasq-escape.js';

/**
 * Duplicate-logic audit #7 (two domain validators) and #20 (one record-name
 * validator under two names).
 *
 * #20 was an exact duplicate, so the bar is "the unified one behaves like both
 * originals". Those originals are frozen below and diffed, rather than trusted
 * to be equivalent by reading.
 *
 * #7 is NOT a pure dedup: the shared validator was genuinely too loose and is
 * deliberately tightened here, so this pins the new rule and, just as
 * importantly, pins what was deliberately NOT tightened.
 */

// Frozen copies of the two pre-unification implementations (#20).
// routes/dns.js `isValidHostname`:
function oldIsValidHostname(name) {
  const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
  if (name === '@') return true;
  if (typeof name !== 'string' || name.length > 253) return false;
  return HOSTNAME_RE.test(name.replace(/\.$/, ''));
}
// routes/pihole.js `isValidRecordName`:
function oldIsValidRecordName(name) {
  if (name === '@') return true;
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 253
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name.replace(/\.$/, ''));
}

const NAME_CASES = [
  '@', 'www', 'mail', 'mail.eu', '_acme-challenge', '_sip._tcp',
  'a-b', 'a_b', 'a.b.c', 'www.', 'host-1', 'x',
  '', '.', '..', '-www', 'www-', '.www', 'www..eu', 'a b', 'a/b', 'a,b',
  'a\nb', 'a=b', 'a'.repeat(253), 'a'.repeat(254),
  null, undefined, 42, {}, [],
];

describe('#20: unified isValidRecordName matches both originals', () => {
  it('agrees with routes/dns.js isValidHostname on every case', () => {
    for (const c of NAME_CASES) {
      expect(isValidRecordName(c), `isValidRecordName(${JSON.stringify(c)})`)
        .toBe(oldIsValidHostname(c));
    }
  });

  it('agrees with routes/pihole.js isValidRecordName on every case', () => {
    for (const c of NAME_CASES) {
      expect(isValidRecordName(c), `isValidRecordName(${JSON.stringify(c)})`)
        .toBe(oldIsValidRecordName(c));
    }
  });

  it('the two originals did in fact agree, which is why one could replace both', () => {
    // If this ever fails, the merge was not a dedup and #20 was mis-filed.
    for (const c of NAME_CASES) {
      expect(oldIsValidHostname(c), `originals disagree on ${JSON.stringify(c)}`)
        .toBe(oldIsValidRecordName(c));
    }
  });

  it('covers both verdicts, so agreement is not vacuous', () => {
    expect(NAME_CASES.some(c => isValidRecordName(c))).toBe(true);
    expect(NAME_CASES.some(c => !isValidRecordName(c))).toBe(true);
  });
});

describe('#7: isValidDomain now refuses what is never a domain', () => {
  it('rejects a dotted-quad, the case that reached the dnsmasq writers', () => {
    for (const s of ['10.0.0.1', '192.168.1.1', '0.0.0.0', '999.1.1.1']) {
      expect(isValidDomain(s), s).toBe(false);
    }
  });

  it('rejects empty labels', () => {
    for (const s of ['sub..evil.com', 'x..y', '.example.com', 'example.com.', '.', '..']) {
      expect(isValidDomain(s), s).toBe(false);
    }
  });

  it('rejects a label longer than 63 characters', () => {
    expect(isValidDomain(`${'a'.repeat(64)}.com`)).toBe(false);
    expect(isValidDomain(`${'a'.repeat(63)}.com`)).toBe(true);
  });
});

describe('#7: what was deliberately NOT tightened', () => {
  // These are the regression risks. Each one is a config that exists in the
  // field, so a future "tidy up the domain regex" must not quietly break them.
  it('still accepts a SINGLE label, because domain=lan is a real config', () => {
    for (const s of ['lan', 'local', 'home', 'localhost', 'internal']) {
      expect(isValidDomain(s), s).toBe(true);
    }
  });

  it('still accepts mixed case, because DNS is case-insensitive', () => {
    // Normalization is the storage layer's job (migration 052), not this one's.
    expect(isValidDomain('Evil.COM')).toBe(true);
    expect(isValidDomain('Home.Lan')).toBe(true);
  });

  it('still accepts ordinary domains and hyphens', () => {
    for (const s of ['home.lan', 'a-b.example.com', 'x.y.z.example.co.uk']) {
      expect(isValidDomain(s), s).toBe(true);
    }
  });

  it('still rejects what it always rejected', () => {
    for (const s of ['-bad.com', 'bad-.com', '', 'a'.repeat(254)]) {
      expect(isValidDomain(s), s).toBe(false);
    }
    for (const s of [null, undefined, 42, {}]) {
      expect(isValidDomain(s), String(s)).toBe(false);
    }
  });
});
