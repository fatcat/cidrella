/**
 * Bring the backend's DHCP leases into the database. The backend reads and
 * normalizes its leases (getDhcpBackend().readLeases); what CIDRella keeps of
 * them, and the names and DNS records they get, is decided here.
 */
import { getDhcpBackend, onBackendChanged } from '../backends/index.js';
import { findSubnetForIp } from '../utils/ip-sync.js';
import { generateFallbackHostname } from '../utils/mac-vendor.js';
import { assignLeaseNames, replaceLeases, syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import { dhcpLeaseRejectionReason } from './ip-lifecycle-service.js';

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
let running = null;
let syncAgain = false;
let holds = 0;
let skippedWhileHeld = false;

// One sync at a time. A change seen while one runs is synced after it, once.
// While a hold is on (a DHCP server switch), a change is synced when it ends.
function runLeaseSync(label) {
  if (holds > 0) {
    skippedWhileHeld = true;
    return running;
  }
  if (running) {
    syncAgain = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        syncAgain = false;
        try {
          await syncLeasesNow(syncDb);
        } catch (err) {
          console.warn(`${label}:`, err.message);
        }
      } while (syncAgain && holds === 0);
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Stop syncing until the returned release is called, once any sync under
 * way has finished. A switch of the DHCP server holds it: the new server has
 * no leases until they are handed over, and syncing that would release them
 * all. Changes seen meanwhile are synced on release.
 */
export async function holdLeaseSync() {
  holds++;
  if (running) await running;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0 && skippedWhileHeld) {
      skippedWhileHeld = false;
      if (syncDb) runLeaseSync('Lease sync error');
    }
  };
}

/**
 * Sync now, then every time the DHCP backend says its leases may have
 * changed, following the role to another backend when it moves. Returns
 * the stop.
 */
export function startLeaseSync(db) {
  syncDb = db;
  let stopWatching = null;
  const watch = () => {
    stopWatching?.();
    stopWatching = getDhcpBackend().watchLeases(() => runLeaseSync('Lease sync error'));
  };
  const unsubscribe = onBackendChanged((role) => {
    if (role === 'dhcp') {
      watch();
      runLeaseSync('Lease sync error');
    }
  });
  runLeaseSync('Initial lease sync failed');
  watch();
  return () => {
    unsubscribe();
    stopWatching?.();
  };
}
