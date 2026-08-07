/**
 * Differential test: the JS semver comparator against the bash one.
 *
 * `server/src/utils/semver.js` and `scripts/lib/slots.sh` implement the same
 * semver 2.0 ordering in two languages, because bash cannot import JS. Between
 * them they decide the downgrade guard, the min_from skip-upgrade gate, and
 * which release the update checker offers. If they ever disagree, a host takes
 * the wrong upgrade decision.
 *
 * The JS file's header already claims it "mirrors the semver_cmp in
 * scripts/lib/slots.sh so both sides of the restore/update flow agree". That
 * claim had nothing enforcing it. This is the enforcement.
 *
 * The duplication itself is deliberate and is NOT a bug to fix: the two live on
 * opposite sides of a boundary a normal import cannot cross. What was missing
 * was a test that fails the moment they drift. See REVIEW.md, duplicate-logic
 * audit #2.
 *
 * If this test fails, do not "fix" it by editing the fixture table. Find which
 * of the two implementations changed and decide which one is right.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { compareSemver } from '../../../src/utils/semver.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SLOTS_LIB = path.join(REPO_ROOT, 'scripts/lib/slots.sh');

// Every pair is run through BOTH implementations. Grouped by what they probe so
// a failure says which property broke, not just "a pair disagreed".
const PAIRS = [
  // plain ordering
  ['0.4.15', '0.4.16'],
  ['0.4.16', '0.4.15'],
  ['0.4.16', '0.4.16'],
  // numeric, not lexical: .9 < .10
  ['0.4.9', '0.4.10'],
  ['0.10.0', '0.9.0'],
  ['1.0.0', '0.9.9'],
  // a prerelease ranks below its own release, and above the previous one
  ['0.4.15', '0.4.16-pre.1'],
  ['0.4.16-pre.1', '0.4.16'],
  ['1.0.0', '1.0.0-alpha'],
  // prerelease identifiers: numeric compares numerically, so pre.2 < pre.10
  ['0.4.16-pre.1', '0.4.16-pre.2'],
  ['0.4.16-pre.2', '0.4.16-pre.10'],
  ['0.4.16-pre.5', '0.4.16-pre.5'],
  // prerelease identifiers: alphanumeric compares lexically
  ['1.0.0-alpha', '1.0.0-beta'],
  ['1.0.0-alpha.1', '1.0.0-alpha.2'],
  ['1.0.0-rc.1', '1.0.0-pre.1'],
  // a shorter identifier set ranks below a longer one with the same prefix
  ['1.0.0-alpha', '1.0.0-alpha.1'],
  ['0.4.16-pre.1', '0.4.16-pre.1.1'],
  // numeric identifiers rank below alphanumeric ones
  ['1.0.0-1', '1.0.0-alpha'],
  // build metadata is ignored for precedence
  ['1.0.0+build1', '1.0.0+build2'],
  ['1.0.0+build1', '1.0.0'],
  // tolerated shapes: a leading v, and a truncated core
  ['v1.2.3', '1.2.3'],
  ['1.2', '1.2.0'],
  ['1', '1.0.0'],
];

// One bash call per pair. Slower than batching through stdin, but a failure
// then names the exact pair instead of an offset into a result list.
function bashSemverCmp(a, b) {
  return execFileSync(
    'bash',
    ['-c', '. "$1"; semver_cmp "$2" "$3"', 'bash', SLOTS_LIB, a, b],
    { encoding: 'utf8' }
  ).trim();
}

describe('semver: the bash and JS implementations agree', () => {
  it('has the bash library where the test expects it', () => {
    // If slots.sh moves, fail here with a clear reason rather than through a
    // wall of confusing per-pair failures.
    expect(fs.existsSync(SLOTS_LIB), `${SLOTS_LIB} not found`).toBe(true);
  });

  it.each(PAIRS)('compareSemver(%s, %s) matches semver_cmp', (a, b) => {
    const js = String(compareSemver(a, b));
    const bash = bashSemverCmp(a, b);
    expect(bash, `bash semver_cmp("${a}", "${b}") returned ${bash}, JS returned ${js}`).toBe(js);
  });

  it('both use the same -1 / 0 / 1 contract', () => {
    // A comparator returning "some negative number" on one side and exactly -1
    // on the other would still sort correctly but would break `[ "$(...)" = "-1" ]`,
    // which is how slots.sh builds semver_lt / semver_gt / semver_eq.
    for (const [a, b] of PAIRS) {
      expect(['-1', '0', '1']).toContain(String(compareSemver(a, b)));
      expect(['-1', '0', '1']).toContain(bashSemverCmp(a, b));
    }
  });
});
