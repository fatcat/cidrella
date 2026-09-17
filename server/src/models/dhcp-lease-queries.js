/**
 * Per-address lease reads and deletes used by offline retirement.
 *
 * A deliberate leaf module with no imports. The lifecycle service is the
 * allocation authority, and dhcp-lease.js must call into it to observe
 * synced leases. If the service also imported dhcp-lease.js for these two
 * statements, the two files would form an import cycle. Keeping them here
 * gives the service a dependency that cannot point back at it, while the
 * dhcp_leases writes stay in a models/dhcp-* file as check-db-ownership
 * requires.
 */

export function findLeasesByAddress(db, subnetId, ip) {
  return db
    .prepare(
      `
    SELECT ip_address, mac_address, client_id, expires_at, dhcp_version, duid, iaid
    FROM dhcp_leases
    WHERE subnet_id = ? AND ip_address = ?
  `,
    )
    .all(subnetId, ip);
}

export function deleteLeasesByAddress(db, subnetId, ip) {
  return db
    .prepare('DELETE FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?')
    .run(subnetId, ip);
}
