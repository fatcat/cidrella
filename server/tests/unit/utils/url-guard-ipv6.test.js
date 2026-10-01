/**
 * The outbound URL guard with IPv6 (IPV6-40). With the IPv6 switch off it is
 * the IPv4-only guard it always was; with it on, an IPv6 literal or an
 * AAAA-only host is allowed when the address is public, and a host with both
 * families still connects over IPv4.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import dns from 'dns';

let ipv6On = false;
vi.mock('../../../src/utils/ipv6-support.js', () => ({ ipv6Enabled: () => ipv6On }));

const { validateOutboundUrl } = await import('../../../src/utils/url-guard.js');

const answers = new Map([
  [
    'dual.example',
    [
      { address: '2606:4700::6810:84e5', family: 6 },
      { address: '104.16.132.229', family: 4 },
    ],
  ],
  ['v6only.example', [{ address: '2606:4700::6810:84e5', family: 6 }]],
  ['v6private.example', [{ address: 'fd00::5', family: 6 }]],
]);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(dns.promises, 'lookup').mockImplementation(async (host, { family }) => {
    const list = (answers.get(host) || []).filter((a) => !family || a.family === family);
    if (list.length === 0) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return list;
  });
});

describe('with IPv6 support off', () => {
  beforeEach(() => {
    ipv6On = false;
  });

  it('refuses an IPv6 literal and resolves names over IPv4 only', async () => {
    expect(await validateOutboundUrl('https://[2606:4700::1]/feed')).toMatchObject({
      ok: false,
      reason: 'IPv6 URLs need IPv6 support switched on',
    });
    expect(await validateOutboundUrl('https://dual.example/feed')).toMatchObject({
      ok: true,
      ip: '104.16.132.229',
    });
    const v6only = await validateOutboundUrl('https://v6only.example/feed');
    expect(v6only.ok).toBe(false);
    expect(v6only.reason).toMatch(/does not resolve \(IPv4\)/);
  });
});

describe('with IPv6 support on', () => {
  beforeEach(() => {
    ipv6On = true;
  });

  it('allows a public IPv6 literal and an AAAA-only host', async () => {
    expect(await validateOutboundUrl('https://[2606:4700::1]/feed')).toMatchObject({
      ok: true,
      ip: '2606:4700::1',
    });
    expect(await validateOutboundUrl('https://v6only.example/feed')).toMatchObject({
      ok: true,
      ip: '2606:4700::6810:84e5',
    });
  });

  it('prefers IPv4 for a host with both families', async () => {
    expect(await validateOutboundUrl('https://dual.example/feed')).toMatchObject({
      ok: true,
      ip: '104.16.132.229',
    });
  });

  it('refuses loopback, unique local, link-local and mapped private addresses', async () => {
    for (const url of [
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[::ffff:10.0.0.1]/x',
      'http://v6private.example/x',
    ]) {
      const res = await validateOutboundUrl(url);
      expect([url, res.ok]).toEqual([url, false]);
    }
    // IPv4 is unchanged.
    expect((await validateOutboundUrl('http://127.0.0.1/x')).ok).toBe(false);
  });
});
