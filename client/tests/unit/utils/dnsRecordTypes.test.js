import { describe, expect, it } from 'vitest';
import { recordTypesFor } from '../../../src/utils/dnsRecordTypes.js';

describe('recordTypesFor', () => {
  it('offers AAAA in a forward zone only while IPv6 support is on', () => {
    expect(recordTypesFor({ zoneType: 'forward', ipv6: false })).toEqual([
      'A',
      'CNAME',
      'MX',
      'TXT',
      'SRV',
      'PTR',
    ]);
    expect(recordTypesFor({ zoneType: 'forward', ipv6: true })).toContain('AAAA');
  });

  it('a reverse zone takes PTR only, whatever the switch says', () => {
    expect(recordTypesFor({ zoneType: 'reverse', ipv6: true })).toEqual(['PTR']);
  });
});
