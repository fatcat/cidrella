import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const UI = path.join(SRC, 'ui');

/**
 * The widget-library seam (client/src/ui/).
 *
 * PrimeVue was archived and relicensed, so CIDRella moved to OpenVue, an
 * API-compatible community fork. Every vendor specifier lives in ui/ and
 * nowhere else, which made that swap 32 files and gives one place to absorb
 * API drift from a 1.0 fork.
 *
 * That property is only worth anything if it holds, and nothing about writing
 * `import Button from 'openvue/button'` in a new component would fail a build.
 * Hence this test.
 *
 * The pattern below matches the OLD vendor names too. primevue is no longer a
 * dependency, so naming it is a broken import rather than a style problem, and
 * this is the cheapest place to catch it.
 *
 * tests/ is scanned as well, which it was not originally. The OpenVue swap
 * broke IpDetailsDrawer.test.js because it mocked 'primevue/usetoast'
 * directly while the component itself correctly imported ../ui/useToast.js.
 * A test that reaches past the seam makes the seam a half-truth.
 */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// Two regexes on purpose. A /g regex is STATEFUL via lastIndex, so reusing one
// for both matchAll and test makes repeated test() calls alternate true/false.
// The first version of this file did exactly that and the vacuity check below
// caught it, which is the check earning its place.
const VENDOR = String.raw`(openvue\/[^'"]+|@openvue\/[^'"]+|primevue\/[^'"]+|@primeuix\/[^'"]+)`;
const VENDOR_ALL = new RegExp(String.raw`from\s+['"]${VENDOR}['"]`, 'g');
const VENDOR_ONE = new RegExp(String.raw`from\s+['"]${VENDOR}['"]`);
// vi.mock() takes a specifier too, and reaches past the seam just as well.
const VENDOR_MOCK = new RegExp(String.raw`vi\.mock\(\s*['"]${VENDOR}['"]`, 'g');
const ALL = walk(SRC);
const APP = ALL.filter((f) => !f.startsWith(UI + path.sep));
// This file necessarily contains vendor specifiers as fixtures, so it is
// excluded from its own scan.
const SELF = fileURLToPath(import.meta.url);
const TESTS = walk(path.resolve(path.dirname(SELF), '..')).filter((f) => f !== SELF);

describe('ui seam: only client/src/ui names the widget library', () => {
  it('scanned a meaningful number of files', () => {
    expect(ALL.length).toBeGreaterThan(80);
    expect(APP.length).toBeGreaterThan(80);
  });

  it('no application file imports the vendor directly', () => {
    const offenders = [];
    for (const f of APP) {
      const hits = [...fs.readFileSync(f, 'utf8').matchAll(VENDOR_ALL)].map((m) => m[1]);
      if (hits.length)
        offenders.push(`${path.relative(SRC, f)} -> ${[...new Set(hits)].join(', ')}`);
    }
    expect(
      offenders,
      `import from '../ui/<Name>.js' instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ui/ does name the vendor, so the check above is not vacuous', () => {
    const naming = fs
      .readdirSync(UI)
      .filter((n) => n.endsWith('.js'))
      .filter((n) => VENDOR_ONE.test(fs.readFileSync(path.join(UI, n), 'utf8')));
    expect(naming.length).toBeGreaterThan(25);
  });

  it('every ui/ module re-exports rather than reimplementing', () => {
    // A seam that starts growing logic stops being a seam. Shims are expected
    // eventually, but they should be a deliberate edit that fails here first.
    for (const n of fs.readdirSync(UI).filter((f) => f.endsWith('.js'))) {
      const body = fs
        .readFileSync(path.join(UI, n), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('//'))
        .join('\n');
      expect(body, `${n} should be re-exports only`).toMatch(/^export\s/m);
      expect(body, `${n} should not declare functions or components`).not.toMatch(
        /\b(function|class|defineComponent)\b/,
      );
    }
  });

  it('no test file names the vendor either, by import or by vi.mock', () => {
    const offenders = [];
    for (const f of TESTS) {
      const body = fs.readFileSync(f, 'utf8');
      const hits = [
        ...[...body.matchAll(VENDOR_ALL)].map((m) => m[1]),
        ...[...body.matchAll(VENDOR_MOCK)].map((m) => m[1]),
      ];
      if (hits.length) offenders.push(`${path.basename(f)} -> ${[...new Set(hits)].join(', ')}`);
    }
    expect(
      offenders,
      `mock the seam (../src/ui/<Name>.js) instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the guard actually catches a direct import and a direct mock', () => {
    expect([...`import Button from 'openvue/button';`.matchAll(VENDOR_ALL)]).toHaveLength(1);
    expect([...`import B from 'primevue/button';`.matchAll(VENDOR_ALL)]).toHaveLength(1);
    expect([...`vi.mock('openvue/usetoast', () => ({}));`.matchAll(VENDOR_MOCK)]).toHaveLength(1);
  });
});
