import '../../../helpers/isolated-data-dir.js';
import { describe, it, expect } from 'vitest';
import {
  RESERVED_LOCAL_DOMAINS,
  SITE_LOCAL_DOMAINS,
  reservedLocalDomains,
} from '../../../../src/backends/shared/reserved-zones.js';

describe('reservedLocalDomains', () => {
  it('answers the site names locally only while every upstream is public, either family', () => {
    for (const addresses of [['9.9.9.9'], ['2620:fe::fe'], ['9.9.9.9', '2620:fe::9']]) {
      expect(reservedLocalDomains({ addresses })).toEqual([
        ...RESERVED_LOCAL_DOMAINS,
        ...SITE_LOCAL_DOMAINS,
      ]);
    }
    for (const addresses of [['10.0.0.53'], ['9.9.9.9', 'fd00::53']]) {
      expect(reservedLocalDomains({ addresses })).toEqual([...RESERVED_LOCAL_DOMAINS]);
    }
  });

  it('answers the carrier-grade NAT reverse zones as a site name (RFC 7793, IPv4 only)', () => {
    const cgnat = Array.from({ length: 64 }, (_, i) => `${64 + i}.100.in-addr.arpa`);
    expect(SITE_LOCAL_DOMAINS).toEqual(expect.arrayContaining(cgnat));
    expect(SITE_LOCAL_DOMAINS).not.toContain('63.100.in-addr.arpa');
    expect(SITE_LOCAL_DOMAINS).not.toContain('128.100.in-addr.arpa');
    expect(reservedLocalDomains({ addresses: ['9.9.9.9'] })).toEqual(
      expect.arrayContaining(cgnat),
    );
    expect(reservedLocalDomains({ addresses: ['100.64.0.53'] })).not.toContain(
      '64.100.in-addr.arpa',
    );
  });
});
