// Shared semver 2.0 comparator. Previously lived as local copies in both
// update-checker.js and releases-manifest.js to avoid a circular import
// between the two; the duplication bit us in v0.4.15-pre.2 when the
// update-checker copy was rewritten for semver 2.0 but the
// releases-manifest copy wasn't. Result: on prod the manifest-based
// reachability check claimed v0.4.14 > v0.4.15-pre.2 and offered a
// downgrade as an "update." Extracting the one canonical implementation
// here breaks the circular-dep worry and guarantees both sides agree.

// Compare two semver strings per semver 2.0.
// Returns -1 if a < b, 0 if equal, 1 if a > b.
//
// Handles prerelease tags correctly:
//   - v0.4.13 < v0.4.15-pre.1 < v0.4.15  (a version WITHOUT a prerelease
//     outranks the same base version WITH one)
//   - v0.4.15-pre.1 < v0.4.15-pre.2      (numeric identifiers compare numerically)
//   - v0.4.15-alpha < v0.4.15-beta       (alphanumeric identifiers compare lex)
//
// Mirrors the semver_cmp in scripts/lib/slots.sh so both sides of the
// restore/update flow agree.
export function compareSemver(a, b) {
  const parse = (s) => {
    s = String(s).replace(/^v/, '').split('+')[0];          // drop build metadata
    const [core, pre] = s.split(/-(.*)/, 2);                 // split core from prerelease
    const [mj = '0', mn = '0', pt = '0'] = core.split('.');
    return {
      core: [parseInt(mj, 10) || 0, parseInt(mn, 10) || 0, parseInt(pt, 10) || 0],
      pre: pre ? pre.split('.') : [],
    };
  };
  const cmpId = (x, y) => {
    const xN = /^\d+$/.test(x), yN = /^\d+$/.test(y);
    if (xN && yN) {
      const n = parseInt(x, 10) - parseInt(y, 10);
      return n === 0 ? 0 : (n < 0 ? -1 : 1);
    }
    if (xN) return -1;  // numeric identifier has lower precedence than alphanumeric
    if (yN) return 1;
    return x === y ? 0 : (x < y ? -1 : 1);
  };

  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] < pb.core[i]) return -1;
    if (pa.core[i] > pb.core[i]) return 1;
  }
  // Cores equal. A version without a prerelease tag outranks one with.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const c = cmpId(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  // All compared identifiers equal, the longer prerelease outranks (semver 2.0 §11.4.4).
  return pa.pre.length < pb.pre.length ? -1 : (pa.pre.length > pb.pre.length ? 1 : 0);
}
