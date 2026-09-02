/**
 * "Is this DHCP lease still active?" as SQL, in one place.
 *
 * This predicate was written out by hand in 12 queries across five files, with
 * a related ordering fragment in another four (duplicate-logic audit #26). They
 * all agreed, but one business rule copied 16 times is the exact shape that has
 * already bitten this codebase more than once, and there was nothing to stop
 * the seventeenth copy differing.
 *
 * A deliberate leaf module: no imports, so it cannot participate in an import
 * cycle no matter who pulls it in. Same reasoning as scan-coverage.js, which
 * this sits next to conceptually.
 *
 * KNOWN and deliberate divergence from the JavaScript twin,
 * `activeLease()` in models/ip-view.js. SQLite's datetime() truncates to whole
 * seconds and this uses `>`; the JS builds a Date with millisecond precision
 * and uses `>=`. They therefore disagree for at most the one second in which a
 * lease expires, and only for a lease expiring exactly now. Unifying would mean
 * either giving up sub-second precision in JS or hand-rolling millisecond
 * arithmetic in SQL, and a lease boundary is not observed to that resolution by
 * anything here. Recorded rather than fixed, and pinned by a test so it stays a
 * decision rather than becoming a surprise.
 */

function col(alias, name = 'expires_at') {
  return alias ? `${alias}.${name}` : name;
}

/**
 * The active-lease predicate. Returns a parenthesised expression safe to drop
 * into a WHERE or an EXISTS.
 *
 * @param {string} alias table alias, or '' when the query has none
 */
export function activeLeaseSql(alias = '') {
  const e = col(alias);
  return `(${e} = 'infinite' OR datetime(${e}) > datetime('now'))`;
}

/**
 * ORDER BY fragment putting infinite leases first. A reservation reaches the
 * lease file as `expires_at = 'infinite'`, and where several leases exist for
 * one address the reserved one is the one to believe.
 */
export function infiniteLeaseFirstSql(alias = '') {
  return `CASE WHEN ${col(alias)} = 'infinite' THEN 1 ELSE 0 END DESC`;
}
