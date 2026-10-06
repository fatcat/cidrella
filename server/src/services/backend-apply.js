/**
 * Apply the database to the DNS/DHCP backends. These are what the after-commit
 * hooks run, and the one place work that belongs to CIDRella (not the backend)
 * is sequenced around a backend apply.
 *
 * Tests of routes and services mock this module, not the adapter: stubbing
 * applyDhcp here also skips the DHCP name sync, as stubbing the old
 * regenerateDhcpConfigs did.
 */
import { getDhcpBackend, getDnsBackend, getService } from '../backends/index.js';
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

// Hook names are stored in configuration_generations (a CHECK in migration
// 065 lists them), so they keep their original spelling.
export const HOOK_HANDLERS = {
  regenerate_dns: (db) => applyDns(db),
  regenerate_dhcp: (db) => applyDhcp(db),
  regenerate_dnsmasq_conf: (db) => applyResolver(db),
};
