import { describe, it, expect } from 'vitest';
import { isValidLeaseTime, leaseDurationMs, leaseSeconds } from '../../../src/utils/lease-time.js';

describe('lease times', () => {
  it('reads every stored spelling as seconds', () => {
    expect(leaseSeconds('3600')).toBe(3600);
    expect(leaseSeconds('90s')).toBe(90);
    expect(leaseSeconds('30m')).toBe(1800);
    expect(leaseSeconds('12h')).toBe(43200);
    expect(leaseSeconds('7d')).toBe(604800);
    expect(leaseSeconds('2w')).toBe(1209600);
    expect(leaseSeconds(' 1H ')).toBe(3600);
    expect(leaseSeconds('infinite')).toBe(Infinity);
    expect(leaseDurationMs('1m')).toBe(60000);
  });

  it('reads garbage as NaN', () => {
    for (const bad of ['', null, undefined, '1.5h', '-1h', 'h', '1y', '1 h']) {
      expect(leaseSeconds(bad), String(bad)).toBeNaN();
    }
  });

  it('accepts the spellings the API has always taken, and no others', () => {
    for (const ok of ['3600', '45s', '30m', '12h', '1d']) expect(isValidLeaseTime(ok)).toBe(true);
    for (const bad of ['2w', 'infinite', '1.5h', '', ' 1h', 3600, null]) {
      expect(isValidLeaseTime(bad), String(bad)).toBe(false);
    }
  });
});
