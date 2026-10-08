import { describe, it, expect } from 'vitest';
import { createReservoir, quantileOfSorted } from '../../../src/utils/samples.js';

describe('createReservoir', () => {
  it('peeks without emptying, and drains to empty', () => {
    const r = createReservoir(10);
    [5, 1, 3].forEach((v) => r.add(v));
    expect(r.peek()).toEqual({ sorted: [1, 3, 5], seen: 3 });
    expect(r.peek()).toEqual({ sorted: [1, 3, 5], seen: 3 });
    expect(r.drain()).toEqual({ sorted: [1, 3, 5], seen: 3 });
    expect(r.peek()).toEqual({ sorted: [], seen: 0 });
  });

  it('keeps at most its size but counts every value', () => {
    const r = createReservoir(4);
    for (let i = 0; i < 100; i++) r.add(i);
    const { sorted, seen } = r.drain();
    expect(sorted).toHaveLength(4);
    expect(seen).toBe(100);
  });
});

describe('quantileOfSorted', () => {
  it('takes the nearest rank, and null for nothing', () => {
    expect(quantileOfSorted([1, 2, 3, 4], 0.5)).toBe(3);
    expect(quantileOfSorted([1, 2, 3, 4], 0.95)).toBe(4);
    expect(quantileOfSorted([], 0.5)).toBeNull();
  });
});
