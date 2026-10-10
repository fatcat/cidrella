import { describe, it, expect } from 'vitest';

describe('generateReverseNames', () => {
  it('names one ip6.arpa zone at the nibble boundary of the prefix', async () => {
    const { generateReverseNames } = await import('../../../src/utils/reverse-zones.js');
    expect(generateReverseNames('fd00:6::/64')).toEqual([
      '0.0.0.0.0.0.0.0.6.0.0.0.0.0.d.f.ip6.arpa',
    ]);
    expect(generateReverseNames('2001:db8:1234::/50')).toEqual([
      '4.3.2.1.8.b.d.0.1.0.0.2.ip6.arpa',
    ]);
    expect(generateReverseNames('2001:db8::/32')).toEqual(['8.b.d.0.1.0.0.2.ip6.arpa']);
    expect(generateReverseNames('10.0.0.0/22')).toEqual([
      '0.0.10.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '2.0.10.in-addr.arpa',
      '3.0.10.in-addr.arpa',
    ]);
  });
});

describe('reverseZoneNetwork', () => {
  it('turns a zone name back into the network it covers', async () => {
    const { reverseZoneNetwork } = await import('../../../src/utils/reverse-zones.js');
    expect(reverseZoneNetwork('1.0.10.in-addr.arpa')).toBe('10.0.1.0/24');
    expect(reverseZoneNetwork('16.172.in-addr.arpa')).toBe('172.16.0.0/16');
    expect(reverseZoneNetwork('10.in-addr.arpa')).toBe('10.0.0.0/8');
    expect(reverseZoneNetwork('8.b.d.0.1.0.0.2.ip6.arpa')).toBe('2001:db8::/32');
    expect(reverseZoneNetwork('0.0.0.0.0.0.0.0.6.0.0.0.0.0.d.f.ip6.arpa')).toBe('fd00:6::/64');
    expect(reverseZoneNetwork('example.test')).toBeNull();
    expect(reverseZoneNetwork('300.0.10.in-addr.arpa')).toBeNull();
  });
});
