/**
 * Apply the database to the DNS/DHCP backends. These are what the after-commit
 * hooks run, and the one place work that belongs to CIDRella (not the backend)
 * is sequenced around a backend apply.
 *
 * Tests of routes and services mock this module, not the adapter: stubbing
 * applyDhcp here also skips the DHCP name sync, as stubbing the old
 * regenerateDhcpConfigs did.
 */
import { getDhcpBackend, getDnsBackend, getService, uniqueServices } from '../backends/index.js';
import { syncDhcpDnsRecords } from '../models/dhcp-lease.js';

export function applyDns(db) {
  getDnsBackend().applyZones(db);
}

export function applyResolver(db) {
  getDnsBackend().applyResolver(db);
}

// The DHCP hostnames (leases and reservations) go into dns_records after the
// scope files are written and before the backend takes them, so a failed
// write or validation leaves the records alone. Stored leases already carry
// their effective names (ADR 005), the vendor fallback included.
export function applyDhcp(db) {
  const result = getDhcpBackend().applyScopes(db, { activate: false });
  const leases = db
    .prepare(
      'SELECT ip_address as ip, hostname, mac_address as mac, subnet_id as subnetId FROM dhcp_leases',
    )
    .all();
  syncDhcpDnsRecords(db, leases);
  getService('dhcp').applyActivation(result.activation);
}

/**
 * Boot: write the listen and resolver config as one validated change, then
 * make sure every backend service runs its config. A clean reboot with
 * nothing changed and the services up costs no restart. Returns what
 * happened to each service by name ('restarted', 'unchanged', 'failed', or
 * 'skipped' in an update preflight).
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
      const outcome = service.activate({ force: service === dns && dnsChanged });
      if (outcome === 'unchanged') {
        console.log(`${service.name} config unchanged and service running, skipping boot restart`);
      }
      outcomes[service.name] = outcome;
    } catch {
      console.warn(`${service.name} restart failed (may not be installed)`);
      outcomes[service.name] = 'failed';
    }
  }
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
