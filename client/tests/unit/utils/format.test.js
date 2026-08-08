/**
 * formatBytes, the single byte-size formatter.
 *
 * There were two: BackupSettings.vue walked the unit list, HeaderBar.vue knew
 * only GB and MB so 1500 bytes rendered as "0 MB". They disagreed on the
 * missing-value placeholder too, one returning "0 B" and the other "--", which
 * is a third spelling of the empty cell.
 *
 * See REVIEW.md, duplicate-logic audit #44.
 */
import { describe, it, expect } from 'vitest';
import { formatBytes, EMPTY_CELL } from '../../../src/utils/format.js';

describe('formatBytes', () => {
  it('expresses sizes below a megabyte, which the HeaderBar copy could not', () => {
    // The bug: this returned "0 MB".
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('walks the unit ladder', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
    // Caps at TB rather than running off the end of the unit list.
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });

  it('distinguishes a real zero from a missing value', () => {
    // The two copies conflated these: one said "0 B" for both, the other "--".
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe(EMPTY_CELL);
    expect(formatBytes(undefined)).toBe(EMPTY_CELL);
    expect(formatBytes('')).toBe(EMPTY_CELL);
  });

  it('never renders NaN', () => {
    for (const bad of ['abc', {}, [], NaN, Infinity]) {
      expect(String(formatBytes(bad)), `input ${JSON.stringify(bad)}`).not.toContain('NaN');
    }
  });

  it('accepts a numeric string, which is what the API sends for sizes', () => {
    expect(formatBytes('2048')).toBe('2.0 KB');
  });
});
