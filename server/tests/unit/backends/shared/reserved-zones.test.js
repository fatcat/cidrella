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
});
