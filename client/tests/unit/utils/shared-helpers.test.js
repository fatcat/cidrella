import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { subnetLabel } from '../../../src/utils/format.js';
import { INTRADAY_RANGES, isIntradayRange } from '../../../src/utils/ranges.js';
import { RANGE_OPTIONS } from '../../../src/utils/chart-config.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

/** Duplicate-logic audit #60, the five sub-findings F15 to F19. */

describe('#F17: one subnet label rule', () => {
  it('joins cidr and name', () => {
    expect(subnetLabel({ cidr: '10.0.0.0/24', name: 'Office' })).toBe('10.0.0.0/24 — Office');
  });

  it('falls back to the CIDR alone when there is no name', () => {
    // Two of the four copies interpolated the name directly, so a nameless
    // subnet rendered "10.0.0.0/24 — undefined" in the settings pickers.
    for (const name of [undefined, null, '', '   ']) {
      expect(subnetLabel({ cidr: '10.0.0.0/24', name }), String(name)).toBe('10.0.0.0/24');
    }
  });

  it('never renders the string "undefined" or "null"', () => {
    expect(subnetLabel({ cidr: '10.0.0.0/24' })).not.toMatch(/undefined|null/);
  });

  it('handles a missing subnet', () => {
    expect(subnetLabel(null)).toBe('');
    expect(subnetLabel({})).toBe('');
  });
});

describe('#F19: one intraday range vocabulary', () => {
  it('classifies the short ranges', () => {
    for (const r of ['1h', '4h', '12h', '24h']) expect(isIntradayRange(r), r).toBe(true);
    for (const r of ['2d', '1w', 'nonsense', '']) expect(isIntradayRange(r), r).toBe(false);
  });

  it('every intraday range is an offered range option', () => {
    // The failure this prevents: adding a range to the picker without adding it
    // here silently mislabels that chart's axis, and vice versa.
    const offered = RANGE_OPTIONS.map(o => o.value);
    for (const r of INTRADAY_RANGES) {
      expect(offered, `${r} is intraday but not in RANGE_OPTIONS`).toContain(r);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INTRADAY_RANGES)).toBe(true);
  });
});

describe('#F16 / #F18: shared helpers are used, not reimplemented', () => {
  function walk(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
    }
    return acc;
  }
  const FILES = ['components', 'views', 'stores', 'composables']
    .flatMap(d => walk(path.join(SRC, d)));

  it('scanned a meaningful number of files', () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it('#F18: nobody reimplements apiError inline', () => {
    const bad = FILES.filter(f => fs.readFileSync(f, 'utf8').includes('err.response?.data?.error'))
      .map(f => path.relative(SRC, f));
    expect(bad, `import apiError from utils/format.js instead: ${bad.join(', ')}`).toEqual([]);
  });

  it('#F18: nobody reimplements saveJson inline', () => {
    const bad = FILES.filter(f => /localStorage\.setItem\([^;]*JSON\.stringify/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f));
    expect(bad, `import saveJson from utils/storage.js instead: ${bad.join(', ')}`).toEqual([]);
  });

  it('#F16: the allocated-tree walk is not reimplemented in the store', () => {
    const store = fs.readFileSync(path.join(SRC, 'stores/subnets.js'), 'utf8');
    expect(store).toContain('collectAllocatedSubnets');
    expect(store, 'store should not carry its own collectAllocated')
      .not.toMatch(/function collectAllocated\s*\(/);
  });
});
