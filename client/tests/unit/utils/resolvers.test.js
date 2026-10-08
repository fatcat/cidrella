import { describe, it, expect } from 'vitest';
import {
  CUSTOM,
  NONE,
  selection,
  plainSelection,
  encryptedSelection,
  plainAddresses,
  encryptedUpstream,
  selectionKey,
  customCandidates,
  resultSelection,
} from '../../../src/utils/resolvers.js';

const PROVIDERS = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    addresses: ['1.1.1.1', '1.0.0.1'],
    hostname: 'cloudflare-dns.com',
    doh_url: 'https://cloudflare-dns.com/dns-query',
  },
  {
    id: 'quad9',
    label: 'Quad9',
    addresses: ['9.9.9.10', '149.112.112.10'],
    hostname: 'dns10.quad9.net',
    doh_url: 'https://dns10.quad9.net/dns-query',
  },
];

describe('reading saved settings', () => {
  it("knows a preset's plain addresses in any order", () => {
    expect(plainSelection(PROVIDERS, ['1.0.0.1', '1.1.1.1']).choice).toBe('cloudflare');
  });

  it.each([
    ['IPv4', ['192.168.1.53']],
    ['IPv6', ['2001:DB8::53', 'fd00::53']],
  ])('makes other %s addresses a custom resolver', (_family, addresses) => {
    const sel = plainSelection(PROVIDERS, addresses);
    expect(sel.choice).toBe(CUSTOM);
    expect(sel.custom.servers.map((s) => s.ip)).toEqual(addresses);
  });

  it('reads no backup as None, and no primary as an empty custom one', () => {
    expect(plainSelection(PROVIDERS, [], { allowNone: true }).choice).toBe(NONE);
    expect(encryptedSelection(PROVIDERS, undefined, { allowNone: true }).choice).toBe(NONE);
    expect(plainSelection(PROVIDERS, []).choice).toBe(CUSTOM);
  });

  it('knows an encrypted preset by hostname, and keeps a custom one', () => {
    expect(encryptedSelection(PROVIDERS, { hostname: 'DNS10.quad9.net' }).choice).toBe('quad9');
    const custom = encryptedSelection(PROVIDERS, {
      hostname: 'dns.example.net',
      addresses: ['192.0.2.53', '2001:db8::53'],
      doh_url: 'https://dns.example.net/dns-query',
    });
    expect(custom.custom).toMatchObject({
      hostname: 'dns.example.net',
      addresses: '192.0.2.53, 2001:db8::53',
    });
  });
});

describe('writing settings', () => {
  it('gives a preset its addresses and a custom one what was typed', () => {
    expect(plainAddresses(PROVIDERS, selection('quad9'))).toEqual(['9.9.9.10', '149.112.112.10']);
    const custom = selection(CUSTOM, {
      servers: [
        { ip: ' 2001:db8::53 ', status: null },
        { ip: '', status: null },
      ],
    });
    expect(plainAddresses(PROVIDERS, custom)).toEqual(['2001:db8::53']);
    expect(plainAddresses(PROVIDERS, selection(NONE))).toEqual([]);
  });

  it('builds the encrypted upstream, none for None', () => {
    expect(encryptedUpstream(PROVIDERS, selection('cloudflare')).hostname).toBe(
      'cloudflare-dns.com',
    );
    expect(encryptedUpstream(PROVIDERS, selection(NONE))).toBeNull();
    expect(
      encryptedUpstream(
        PROVIDERS,
        selection(CUSTOM, { hostname: ' d.example ', addresses: '192.0.2.1, ,192.0.2.2' }),
      ).addresses,
    ).toEqual(['192.0.2.1', '192.0.2.2']);
  });

  it('treats a respelled IPv6 address as no change', () => {
    const a = selection(CUSTOM, { servers: [{ ip: '2001:DB8::1', status: null }] });
    const b = selection(CUSTOM, { servers: [{ ip: '2001:db8:0::1', status: 'reachable' }] });
    expect(selectionKey(PROVIDERS, a, false)).toBe(selectionKey(PROVIDERS, b, false));
  });
});

describe('the performance test', () => {
  it('sends only complete custom resolvers', () => {
    const typed = selection(CUSTOM, { servers: [{ ip: '192.168.1.53', status: null }] });
    const empty = selection(CUSTOM);
    expect(customCandidates(PROVIDERS, [typed, empty], 'off')).toEqual([
      { addresses: ['192.168.1.53'] },
    ]);
    const noUrl = selection(CUSTOM, { hostname: 'd.example', addresses: '192.0.2.1' });
    expect(customCandidates(PROVIDERS, [noUrl], 'tls')).toHaveLength(1);
    expect(customCandidates(PROVIDERS, [noUrl], 'https')).toHaveLength(0);
    expect(customCandidates(PROVIDERS, [selection('quad9')], 'tls')).toEqual([]);
  });

  it('turns a result row back into a selection', () => {
    expect(resultSelection({ id: 'quad9', preset: true }, true).choice).toBe('quad9');
    const row = { id: 'custom-1', preset: false, hostname: '', addresses: ['fd00::53'] };
    expect(resultSelection(row, false).custom.servers).toEqual([{ ip: 'fd00::53', status: null }]);
  });
});
