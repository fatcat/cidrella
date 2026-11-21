/**
 * What CIDRella keeps of a DHCP backend's leases: which it accepts, the names
 * they get, and the DNS records those names become. This writes the data of
 * record, so it runs where that data is owned (sync/facts.js sends a lease
 * set here).
 */
import { onDhcpRendered } from './backend-apply.js';
import { findSubnetForIp } from '../utils/ip-sync.js';
import { generateFallbackHostname } from '../utils/mac-vendor.js';
import { assignLeaseNames, replaceLeases, syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import {
  dhcpLeaseRejectionReason,
  holdsAnotherClientsReservation,
} from './ip-lifecycle-service.js';

/**
 * Store a backend's whole lease set: leases missing from `leases` are
 * released. Returns how many were kept and how many refused, and the refused
 * leases that hold another client's DHCP Reservation (`blocking`), for
 * syncLeasesNow to release at the backend.
 */
export function ingestLeases(db, leases) {
  const located = [];
  for (const lease of leases) {
    // A DHCPv6 lease without a client DUID has no identity CIDRella can act on.
    if (lease.dhcpVersion === 6 && !lease.duid) continue;
    let subnet;
    try {
      subnet = findSubnetForIp(db, lease.ip);
    } catch {
      subnet = null;
    }
    located.push({ ...lease, subnetId: subnet?.status === 'allocated' ? subnet.id : null });
  }

  const acceptedLeases = [];
  const blocking = [];
  let rejected = 0;
  for (const lease of located) {
    const rejection = dhcpLeaseRejectionReason(db, lease);
    if (rejection) {
      rejected++;
      if (holdsAnotherClientsReservation(db, lease)) blocking.push(lease);
      else console.warn(`Rejected lease ${lease.ip}: ${rejection}`);
    } else {
      acceptedLeases.push(lease);
    }
  }

  // Persist the effective name every reader uses (ADR 005): unique in its
  // zone, sticky to the address holding it, the vendor fallback only for an
  // unnamed client holding none. dnsmasq writes '*' for a client without a
  // name, and for one whose name it handed to another client. A DHCPv6
  // client is named by the MAC its DUID-LLT/LL embeds, when it has one.
  assignLeaseNames(db, acceptedLeases, { fallbackName: generateFallbackHostname });

  replaceLeases(db, acceptedLeases, { lifecycleValidated: true });

  // Sync DHCP hostnames (leases + reservations) into dns_records
  syncDhcpDnsRecords(db, acceptedLeases);

  return { synced: acceptedLeases.length, rejected, blocking };
}

/**
 * Put the DHCP hostnames (leases and reservations) into dns_records from the
 * stored leases, which already carry their effective names (ADR 005), the
 * vendor fallback included.
 */
export function syncStoredDhcpNames(db) {
  const leases = db
    .prepare(
      'SELECT ip_address as ip, hostname, mac_address as mac, subnet_id as subnetId FROM dhcp_leases',
    )
    .all();
  syncDhcpDnsRecords(db, leases);
}

/**
 * Sync the DHCP names on every DHCP apply, once the scope files are written
 * and before the backend takes them: a reservation's name reaches DNS with the
 * change that made it, and a failed write or validation leaves the records
 * alone. Returns the stop.
 */
export function startDhcpNameSync() {
  return onDhcpRendered(syncStoredDhcpNames);
}
