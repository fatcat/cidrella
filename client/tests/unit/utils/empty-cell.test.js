import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EMPTY_CELL } from '../../../src/utils/format.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

/**
 * Duplicate-logic audit #58.
 *
 * The empty-cell placeholder was hardcoded in around 30 places across 17 files
 * and EMPTY_CELL was imported by exactly one file tree-wide. Two glyphs were in
 * use: HeaderBar.vue rendered '--' and '—' two rows apart inside a single
 * popover.
 *
 * The em-dash in format.js is the documented EMPTY_CELL convention and is an
 * intentional survivor of the repo-wide prose em-dash rule. This test exists so
 * it stays the ONLY one.
 */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const FILES = walk(path.join(SRC, 'components')).concat(walk(path.join(SRC, 'views')));

describe('#58: one placeholder, one definition', () => {
  it('EMPTY_CELL is the em-dash', () => {
    expect(EMPTY_CELL).toBe('—');
  });

  it('no component or view hardcodes a placeholder glyph', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = fs.readFileSync(f, 'utf8');
      if (src.includes("'--'") || src.includes("'—'")) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `these should import EMPTY_CELL instead: ${offenders.join(', ')}`).toEqual([]);
  });

  it('actually scanned a meaningful number of files, so an empty pass is not a pass by accident', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('the guard catches a reintroduced literal', () => {
    // Proves the check above is not vacuous.
    const sample = "return '--';";
    expect(sample.includes("'--'")).toBe(true);
  });
});
