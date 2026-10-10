/**
 * Apply the database to the DNS/DHCP backends. These are what the after-commit
 * hooks run, and the one place work that belongs to CIDRella (not the backend)
 * is sequenced around a backend apply.
 *
 * Tests of routes and services mock this module, not the adapter: stubbing
 * applyDhcp here also skips the DHCP name sync, as stubbing the old
 * regenerateDhcpConfigs did.
 */
import { getDnsBackend, getRaBackend, getService, uniqueServices } from '../backends/index.js';
import fs from 'fs';
import { syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import { BACKEND_RESTART_MARKER } from '../config/defaults.js';

export function applyDns(db) {
  getDnsBackend().applyZones(db);
}

export function applyResolver(db) {
  getDnsBackend().applyResolver(db);
}

// The DHCP config and, from another backend, the RAs: written and checked,
// not yet activated.
function renderDhcp(db) {
  const dhcp = getService('dhcp');
  const ra = getRaBackend();
  const result = dhcp.dhcp.applyScopes(db, { activate: false });
  const raResult = ra === dhcp ? null : ra.ra.applyRouterAdvertisements(db, { activate: false });
  return { dhcp, result, ra, raResult };
}

// The DHCP hostnames (leases and reservations) go into dns_records after the
// scope files are written and before the backend takes them, so a failed
// write or validation leaves the records alone. Stored leases already carry
// their effective names (ADR 005), the vendor fallback included. When another
// backend sends the Router Advertisements (Kea serving DHCP, dnsmasq the RA),
// the DHCPv6 scopes go to it too.
export function applyDhcp(db) {
  const { dhcp, result, ra, raResult } = renderDhcp(db);
  const leases = db
    .prepare(
      'SELECT ip_address as ip, hostname, mac_address as mac, subnet_id as subnetId FROM dhcp_leases',
    )
    .all();
  syncDhcpDnsRecords(db, leases);
  dhcp.applyActivation(result.activation);
  if (raResult) ra.applyActivation(raResult.activation);
}

/**
 * Boot: write the listen and resolver config as one validated change, and
 * the DHCP config (a backend that just became the DHCP server, or a restore,
 * may have none on disk), then make sure every backend service runs its
 * config. A clean reboot with
 * nothing changed and the services up costs no restart. Returns what
 * happened to each service by name ('restarted', 'unchanged', 'failed', or
 * 'skipped' in an update preflight). After a restore every service restarts
 * (BACKEND_RESTART_MARKER), so each loads the restored leases.
 */
export function applyAtBoot(db, { preflight = process.env.CIDRELLA_PREFLIGHT === '1' } = {}) {
  const dns = getService('dns');
  let dnsChanged = false;
  try {
    ({ changed: dnsChanged } = dns.transaction(() => {
      const listen = getDnsBackend().applyListen(db, { activate: false });
      const resolver = getDnsBackend().applyResolver(db, { activate: false });
      return { changed: listen.changed || resolver.changed };
    }));
  } catch (err) {
    // The validated writer restored the last config. Keep the management API
    // available so the operator can correct the stored setting or record.
    console.error(`${dns.name} config generation failed; retained previous config:`, err.message);
  }
  const changed = new Set();
  if (dnsChanged) changed.add(dns);
  try {
    const { dhcp, result, ra, raResult } = renderDhcp(db);
    if (result.changed) changed.add(dhcp);
    if (raResult?.changed) changed.add(ra);
  } catch (err) {
    console.error('DHCP config generation failed; retained previous config:', err.message);
  }
  const afterRestore = !preflight && fs.existsSync(BACKEND_RESTART_MARKER);
  const outcomes = {};
  for (const service of uniqueServices()) {
    // update.sh's preflight probe renders into its own data dir; the units
    // on the host belong to the running release, so it never touches them.
    if (preflight) {
      outcomes[service.name] = 'skipped';
      continue;
    }
    try {
      // Restart when the config changed, when OUR unit is down (the specific
      // unit, not any daemon of that name on the host), or when a previous
      // restart failed and the running process may hold a stale config.
      const outcome = service.activate({ force: afterRestore || changed.has(service) });
      if (outcome === 'unchanged') {
        console.log(`${service.name} config unchanged and service running, skipping boot restart`);
      }
      outcomes[service.name] = outcome;
    } catch {
      console.warn(`${service.name} restart failed (may not be installed)`);
      outcomes[service.name] = 'failed';
    }
  }
  if (afterRestore) fs.rmSync(BACKEND_RESTART_MARKER, { force: true });
  return outcomes;
}

/**
 * Write the listen config and restart the backend right away, not through
 * the after-commit hooks: proxy bypass must have the backend on port 53
 * before it returns.
 */
export function applyListenNow(db) {
  getDnsBackend().applyListen(db, { activate: false });
  getService('dns').restart();
}

// Hook names are stored in configuration_generations (a CHECK in migration
// 065 lists them), so they keep their original spelling.
export const HOOK_HANDLERS = {
  regenerate_dns: (db) => applyDns(db),
  regenerate_dhcp: (db) => applyDhcp(db),
  regenerate_dnsmasq_conf: (db) => applyResolver(db),
};
