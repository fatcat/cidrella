/**
 * Pins the two integer-range validators apart.
 *
 * `isIntInRange` is strict (a real number only). `isIntInRangeCoercing` also
 * accepts a string of digits, because the settings surface is string-typed end
 * to end: the `settings` table column is TEXT and the client's Select controls
 * carry string option values ('3', '7', ...), so `PUT /api/settings/:key`
 * legitimately receives "30".
 *
 * These used to be ONE name with TWO behaviors: routes/settings.js and
 * routes/dns.js each carried a local `isIntInRange`, one coercing and one not.
 * The observable effect was that "30" was accepted by the settings route and
 * rejected by the DNS zone route, and neither file's reader had any way to know
 * which one they had. See REVIEW.md, duplicate-logic audit #14.
 *
 * The point of this file is the DIFFERENCE. If someone "simplifies" these back
 * into one function, the string cases below fail. That is the intended alarm,
 * not a test to relax.
 */
import { describe, it, expect } from 'vitest';
import { isIntInRange, isIntInRangeCoercing } from '../../../src/utils/validation.js';

// Values both must agree on, whatever their coercion policy.
const AGREE = [
  { v: 30, lo: 1, hi: 3650, want: true, why: 'plain in-range integer' },
  { v: 1, lo: 1, hi: 3650, want: true, why: 'lower bound is inclusive' },
  { v: 3650, lo: 1, hi: 3650, want: true, why: 'upper bound is inclusive' },
  { v: 0, lo: 1, hi: 3650, want: false, why: 'below range' },
  { v: 3651, lo: 1, hi: 3650, want: false, why: 'above range' },
  { v: 30.5, lo: 1, hi: 3650, want: false, why: 'not an integer' },
  { v: NaN, lo: 1, hi: 3650, want: false, why: 'NaN' },
  { v: null, lo: 1, hi: 3650, want: false, why: 'null' },
  { v: undefined, lo: 1, hi: 3650, want: false, why: 'undefined' },
  { v: true, lo: 1, hi: 3650, want: false, why: 'boolean is not a number here' },
  { v: [30], lo: 1, hi: 3650, want: false, why: 'array must not coerce' },
  { v: {}, lo: 1, hi: 3650, want: false, why: 'object must not coerce' },
  { v: 'abc', lo: 1, hi: 3650, want: false, why: 'non-numeric string' },
  { v: '', lo: 1, hi: 3650, want: false, why: 'empty string' },
  { v: '30.5', lo: 1, hi: 3650, want: false, why: 'decimal string is not an integer' },
  { v: '3651', lo: 1, hi: 3650, want: false, why: 'numeric string above range' },
];

describe('isIntInRange and isIntInRangeCoercing agree on non-string input', () => {
  it.each(AGREE)('$why: $v', ({ v, lo, hi, want }) => {
    expect(isIntInRange(v, lo, hi)).toBe(want);
    expect(isIntInRangeCoercing(v, lo, hi)).toBe(want);
  });
});

describe('they differ on digit strings, deliberately', () => {
  // This is the whole reason there are two of them.
  it.each([
    ['30', 1, 3650],
    ['1', 1, 3650],
    ['3650', 1, 3650],
    ['0030', 1, 3650],
  ])('%s is rejected by the strict one and accepted by the coercing one', (v, lo, hi) => {
    expect(isIntInRange(v, lo, hi)).toBe(false);
    expect(isIntInRangeCoercing(v, lo, hi)).toBe(true);
  });

  it('the coercing one still range-checks after parsing', () => {
    expect(isIntInRangeCoercing('0', 1, 3650)).toBe(false);
    expect(isIntInRangeCoercing('-5', 1, 3650)).toBe(false);
  });

  it('accepts the exact option values the retention Selects send', () => {
    // client/src/views/settings/NetworkSettings.vue historyRetentionOptions.
    // If this breaks, the retention settings UI cannot save.
    for (const v of ['3', '7', '10', '14', '21', '30']) {
      expect(isIntInRangeCoercing(v, 1, 3650)).toBe(true);
    }
  });
});
