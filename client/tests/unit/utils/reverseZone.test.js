import { describe, expect, it } from 'vitest';
import {
  reverseZoneFamily,
  ptrRecordAddress,
  reverseZoneSortKey,
  reverseZoneCidr,
  reverseZoneContains,
  ptrHostHint,
} from '../../../src/utils/reverseZone.js';

describe('reverseZoneFamily', () => {
  it('tells the two arpa spellings apart', () => {
    expect(reverseZoneFamily('1.0.10.in-addr.arpa')).toBe(4);
    expect(reverseZoneFamily('0.0.0.0.4.3.2.1.0.0.d.f.ip6.arpa')).toBe(6);
    expect(reverseZoneFamily('example.com')).toBeNull();
    expect(reverseZoneFamily(null)).toBeNull();
  });
});

describe('ptrRecordAddress', () => {
  it('rebuilds an IPv4 address from the zone and the record labels', () => {
    expect(ptrRecordAddress('0.10.in-addr.arpa', '5.1')).toBe('10.0.1.5');
    expect(ptrRecordAddress('1.0.10.in-addr.arpa', '5')).toBe('10.0.1.5');
    expect(ptrRecordAddress('1.0.10.in-addr.arpa', '')).toBeNull();
  });

  it('rebuilds an IPv6 address from nibbles in the canonical spelling', () => {
    // fd00:1234::/64 zone, host ::10
    const zone = '0.0.0.0.0.0.0.0.4.3.2.1.0.0.d.f.ip6.arpa';
    expect(ptrRecordAddress(zone, '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0')).toBe('fd00:1234::10');
    expect(ptrRecordAddress(zone, '0.1')).toBeNull();
    expect(ptrRecordAddress(zone, 'g.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0')).toBeNull();
  });

  it('is null for a forward zone', () => {
    expect(ptrRecordAddress('example.com', 'www')).toBeNull();
  });
});

describe('reverseZoneSortKey', () => {
  it('orders zones by the network they cover, IPv4 before IPv6', () => {
    const names = [
      '0.0.0.0.0.0.0.0.4.3.2.1.0.0.d.f.ip6.arpa',
      '3.0.10.in-addr.arpa',
      '0.0.0.0.0.0.0.0.4.3.2.1.0.0.c.f.ip6.arpa',
      '1.168.192.in-addr.arpa',
      '10.in-addr.arpa',
    ];
    const sorted = [...names].sort((a, b) =>
      reverseZoneSortKey(a).localeCompare(reverseZoneSortKey(b)),
    );
    expect(sorted).toEqual([
      '10.in-addr.arpa',
      '3.0.10.in-addr.arpa',
      '1.168.192.in-addr.arpa',
      '0.0.0.0.0.0.0.0.4.3.2.1.0.0.c.f.ip6.arpa',
      '0.0.0.0.0.0.0.0.4.3.2.1.0.0.d.f.ip6.arpa',
    ]);
  });

  it('puts anything that is not a reverse zone last', () => {
    expect(reverseZoneSortKey('example.com') > reverseZoneSortKey('10.in-addr.arpa')).toBe(true);
  });
});

describe('ptrHostHint', () => {
  it('labels the host part by family', () => {
    expect(ptrHostHint(4).label).toBe('Last Octet *');
    expect(ptrHostHint(6).label).toBe('Host nibbles *');
    expect(ptrHostHint(6).placeholder).toBe('e.g. 1.0.0.0');
  });

  it('names the network a reverse zone covers, and whether it holds an address', () => {
    expect(reverseZoneCidr('2.0.10.in-addr.arpa')).toBe('10.0.2.0/24');
    expect(reverseZoneCidr('16.172.in-addr.arpa.')).toBe('172.16.0.0/16');
    expect(reverseZoneCidr('8.b.d.0.1.0.0.2.ip6.arpa')).toBe('2001:db8::/32');
    expect(reverseZoneCidr('example.test')).toBeNull();

    expect(reverseZoneContains('2.0.10.in-addr.arpa', '10.0.2.15')).toBe(true);
    expect(reverseZoneContains('2.0.10.in-addr.arpa', '10.0.3.15')).toBe(false);
    expect(reverseZoneContains('16.172.in-addr.arpa', '172.16.200.1')).toBe(true);
    expect(reverseZoneContains('8.b.d.0.1.0.0.2.ip6.arpa', '2001:db8::1')).toBe(true);
    expect(reverseZoneContains('8.b.d.0.1.0.0.2.ip6.arpa', '2001:db9::1')).toBe(false);
    // An address of the other family, or not an address at all.
    expect(reverseZoneContains('2.0.10.in-addr.arpa', '2001:db8::1')).toBe(false);
    expect(reverseZoneContains('2.0.10.in-addr.arpa', '10.0.2')).toBe(false);
  });
});
