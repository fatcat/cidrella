/**
 * Bring the backend's DHCP leases into the database. The backend reads and
 * normalizes its leases (getDhcpBackend().readLeases); what CIDRella keeps of
 * them, and the names and DNS records they get, is decided here.
 */
import { getDhcpBackend } from '../backends/index.js';
import { findSubnetForIp } from '../utils/ip-sync.js';
import { generateFallbackHostname } from '../utils/mac-vendor.js';
import { assignLeaseNames, replaceLeases, syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import { dhcpLeaseRejectionReason } from './ip-lifecycle-service.js';
import { loadFilteringOverrides } from '../utils/dns-proxy.js';

/**
 * Store a backend's whole lease set: leases missing from `leases` are
 * released. Returns how many were kept and how many refused.
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
  let rejected = 0;
  for (const lease of located) {
    const rejection = dhcpLeaseRejectionReason(db, lease);
    if (rejection) {
      rejected++;
      console.warn(`Rejected lease ${lease.ip}: ${rejection}`);
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

  // A host with filtering off is keyed by MAC; its new address takes effect now.
  loadFilteringOverrides();

  return { synced: acceptedLeases.length, rejected };
}

/**
 * Read the backend's leases once they are settled and store them. Every
 * runtime sync goes through here. `read` is passed to readLeases (tests
 * point it at their own lease file and timing).
 */
export async function syncLeasesNow(db, read = {}) {
  const { leases, unsettled } = await getDhcpBackend().readLeases(read);
  if (!leases) return { synced: 0, unsettled: Boolean(unsettled) };
  return ingestLeases(db, leases);
}

let syncDb = null;
let syncRunning = false;
let syncAgain = false;

// One sync at a time. A change seen while one runs is synced after it, once.
async function runLeaseSync(label) {
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  syncRunning = true;
  try {
    do {
      syncAgain = false;
      try {
        await syncLeasesNow(syncDb);
      } catch (err) {
        console.warn(`${label}:`, err.message);
      }
    } while (syncAgain);
  } finally {
    syncRunning = false;
  }
}

/** Sync now, then every time the backend says its leases may have changed. */
export function startLeaseSync(db) {
  syncDb = db;
  runLeaseSync('Initial lease sync failed');
  return getDhcpBackend().watchLeases(() => runLeaseSync('Lease sync error'));
}
