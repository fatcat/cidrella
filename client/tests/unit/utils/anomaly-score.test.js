import { describe, expect, it } from 'vitest';
import {
  SCORE_SCALE,
  deviation,
  mapX,
  moreAnomalousThan,
  worst,
} from '../../../src/utils/anomaly-score.js';

// The stored score is the Isolation Forest decision value: negative is
// anomalous. Every drawing helper has to agree on that sign.
describe('anomaly-score', () => {
  it('deviation is 0 inside the baseline and grows as the score falls', () => {
    expect(deviation(0.2)).toBe(0);
    expect(deviation(0)).toBe(0);
    expect(deviation(-SCORE_SCALE / 2)).toBeCloseTo(0.5);
    expect(deviation(-5)).toBe(1);
    expect(deviation(null)).toBe(0);
    expect(deviation(Number.NaN)).toBe(0);
  });

  it('mapX puts the flag boundary in the middle, flagged to the right', () => {
    expect(mapX(0)).toBe(50);
    expect(mapX(-SCORE_SCALE)).toBe(100);
    expect(mapX(SCORE_SCALE)).toBe(0);
    expect(mapX(-0.35)).toBe(75);
    expect(mapX(undefined)).toBe(50);
  });

  it('worst keeps the more negative score and tolerates a missing one', () => {
    expect(worst(-0.1, -0.4)).toBe(-0.4);
    expect(worst(0.2, -0.05)).toBe(-0.05);
    expect(worst(null, 0.3)).toBe(0.3);
    expect(worst(-0.2, undefined)).toBe(-0.2);
  });

  it('moreAnomalousThan counts the calmer peers, not the lower scores', () => {
    const peers = [0.2, 0.1, -0.1, -0.5];
    expect(moreAnomalousThan(-0.5, peers)).toBe(0.75);
    expect(moreAnomalousThan(0.2, peers)).toBe(0);
    expect(moreAnomalousThan(-0.2, [])).toBe(0);
  });
});
