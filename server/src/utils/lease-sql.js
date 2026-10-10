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
 * KNOWN and deliberate divergence from the JavaScript twin below. SQLite's
 * datetime() truncates to whole
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
 * ORDER BY fragment putting the reserved client's lease first, where several
 * leases name one address (docs/ARCHITECTURE.md). dnsmasq writes a DHCP
 * Reservation's lease with expires_at = 'infinite'; Kea reports its real
 * expiry, so the reservation itself is matched too: an enabled one for the
 * same subnet and address whose MAC (DHCPv4) or DUID (DHCPv6) is the lease's.
 *
 * @param {string} alias table alias, or '' for an unaliased dhcp_leases
 */
export function reservedLeaseFirstSql(alias = '') {
  const t = alias || 'dhcp_leases';
  return `CASE WHEN ${t}.expires_at = 'infinite' OR EXISTS (
      SELECT 1 FROM dhcp_reservations rsv
      WHERE rsv.enabled = 1 AND rsv.subnet_id = ${t}.subnet_id
        AND rsv.ip_address = ${t}.ip_address
        AND (lower(rsv.mac_address) = lower(${t}.mac_address)
          OR lower(rsv.duid) = lower(${t}.duid))
    ) THEN 1 ELSE 0 END DESC`;
}

/** Parse dnsmasq ISO timestamps and SQLite's UTC datetime() text consistently. */
export function leaseExpiryMs(expiresAt) {
  if (expiresAt === 'infinite') return Infinity;
  const raw = String(expiresAt || '').trim();
  if (!raw) return NaN;
  const zoned =
    raw.includes('T') || /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(zoned);
}

export function isLeaseActive(expiresAt, now = Date.now()) {
  const expiry = leaseExpiryMs(expiresAt);
  return expiry === Infinity || (Number.isFinite(expiry) && expiry >= now);
}
