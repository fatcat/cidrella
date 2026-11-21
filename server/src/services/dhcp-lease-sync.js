/**
 * Read the backend's DHCP leases and hand them on as a fact. The backend reads
 * and normalizes its leases (getDhcpBackend().readLeases); what CIDRella keeps
 * of them is decided where the fact lands (sync/facts.js: on a single box,
 * ingestLeases in services/dhcp-lease-ingest.js).
 */
import { getDhcpBackend, onBackendChanged } from '../backends/index.js';
import { onDhcpApplied } from './backend-apply.js';
import { facts } from '../sync/facts.js';
import { loadFilteringOverrides } from '../utils/dns-proxy.js';

/**
 * Release leases that hold a DHCP Reservation's address for another client.
 * The server will not give a leased address to the reservation's client, and
 * a lease that never ends (dnsmasq gives a reserved host one, and a switch
 * used to carry it over) would keep it from that client for good. Never
 * throws: what could not be released is logged and tried on the next sync.
 */
export async function releaseBlockingLeases(leases, backend = getDhcpBackend()) {
  let released = 0;
  for (const lease of leases) {
    const client = lease.duid || lease.mac || 'unknown client';
    let result;
    try {
      result = await backend.releaseLease(lease);
    } catch (err) {
      result = { released: false, error: err.message };
    }
    if (result?.released) {
      released++;
      console.log(
        `Released lease ${lease.ip} (${client}): the address is reserved for another client`,
      );
    } else {
      const why = result?.error || result?.skipped || 'not released';
      console.warn(
        `Could not release lease ${lease.ip} (${client}) blocking its DHCP Reservation: ${why}`,
      );
    }
  }
  return released;
}

/**
 * Read the backend's leases once they are settled and store them. Every
 * runtime sync goes through here. `read` is passed to readLeases (tests
 * point it at their own lease file and timing).
 */
export async function syncLeasesNow(db, read = {}) {
  const { leases, unsettled } = await getDhcpBackend().readLeases(read);
  if (!leases) return { synced: 0, unsettled: Boolean(unsettled) };
  const result = await facts().leases(db, leases);
  // A host with filtering off is keyed by MAC; its new address takes effect now.
  loadFilteringOverrides();
  if (result.blocking.length) result.released = await releaseBlockingLeases(result.blocking);
  return result;
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
      // A change seen during this sync that a hold kept from running is
      // synced when the hold ends.
      if (syncAgain) {
        syncAgain = false;
        skippedWhileHeld = true;
      }
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
 * changed, following the role to another backend when it moves, and after
 * every DHCP apply: a lease on an address that just became another client's
 * reservation is released without waiting for the leases to change. Returns
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
  const stopApplied = onDhcpApplied(() => runLeaseSync('Lease sync error'));
  runLeaseSync('Initial lease sync failed');
  watch();
  return () => {
    unsubscribe();
    stopApplied();
    stopWatching?.();
  };
}
