import { describe, it, expect } from 'vitest';
import { RESERVED_RANGE_COLORS, rangeColorProblem } from '../../../src/utils/range-colors.js';
import { RANGE_COLOR_PRESETS } from '../../../../client/src/utils/rangeTypeColors.js';

describe('rangeColorProblem', () => {
  it('refuses every color the grid uses for a status', () => {
    for (const { color } of RESERVED_RANGE_COLORS) expect(rangeColorProblem(color)).toBeTruthy();
  });

  it('refuses a near neighbor of a status color, in short or long form', () => {
    expect(rangeColorProblem('#f97316')).toMatch(/#f59e0b/); // orange next to amber
    expect(rangeColorProblem('#a855f7')).toMatch(/#8b5cf6/); // purple next to violet
    expect(rangeColorProblem('#e11d48')).toMatch(/#ef4444/); // crimson next to red
    expect(rangeColorProblem('#f00')).toMatch(/#ef4444/); // pure red, far in lightness but one hue
  });

  it('refuses a gray', () => {
    expect(rangeColorProblem('#9ca3af')).toMatch(/gray/);
    expect(rangeColorProblem('#fff')).toMatch(/gray/);
  });

  it('accepts the swatches the dialog offers', () => {
    for (const color of RANGE_COLOR_PRESETS) expect(rangeColorProblem(color)).toBeNull();
  });
});
