/**
 * The dnsmasq backend: one process serving DNS, DHCP (v4 and v6) and Router
 * Advertisements. Each operation wraps the generators in this directory; see
 * backends/contract.js for what the operations promise.
 */
import fs from 'fs';
import { DHCP_LEASE_WATCH_MS } from '../../config/defaults.js';
import {
  applyInterfaceConfig,
  dnsmasqRestartPending,
  dnsmasqSupportsDnssec,
  isCidrellaDnsmasqRunning,
  isDnsmasqRunning,
  regenerateConfDir,
  regenerateDnsmasqConf,
  regenerateHostsDir,
  restartDnsmasq,
  signalDnsmasq,
  withValidatedDnsmasqUpdate,
} from './dnsmasq.js';
import {
  parseLeaseFile,
  regenerateReservations,
  regenerateScopeConfigs,
  removeLegacyLeaseHosts,
} from './dhcp.js';
import { LEASE_FILE, readServerDuid, readSettledLeaseFile } from './lease-file.js';
import { releaseDnsmasqLease } from './lease-release.js';

function applyActivation(activation) {
  if (activation === 'restart') restartDnsmasq();
  else if (activation === 'reload') signalDnsmasq();
}

// One validated write, then the activation it calls for. `write` returns
// the activation; anything but 'none' counts as a change.
function apply(write, { activate = true } = {}) {
  const { activation } = withValidatedDnsmasqUpdate(() => {
    const activation = write();
    return { activation, changed: activation !== 'none' };
  });
  if (activate) applyActivation(activation);
  return {
    changed: activation !== 'none',
    activation,
    activated: activate && activation !== 'none',
  };
}

export function createDnsmasqBackend() {
  return {
    name: 'dnsmasq',
    roles: ['dns', 'dhcp', 'ra'],

    dns: {
      // dnsmasq rereads hostsdir on SIGHUP but not conf-dir, so a change to
      // the zone files (CNAME, MX, TXT, SRV, PTR) costs a restart and a
      // hosts-only change a reload.
      applyZones: (db, opts) =>
        apply(() => {
          const hostsChanged = regenerateHostsDir(db);
          const confChanged = regenerateConfDir(db);
          return confChanged ? 'restart' : hostsChanged ? 'reload' : 'none';
        }, opts),
      applyResolver: (db, opts) =>
        apply(() => (regenerateDnsmasqConf(db) ? 'restart' : 'none'), opts),
      applyListen: (db, opts) => apply(() => (applyInterfaceConfig(db) ? 'restart' : 'none'), opts),
      // DNSSEC starts lenient on signature times (dnssec-no-timecheck); a
      // SIGHUP after the clock syncs makes dnsmasq enforce them.
      onClockSynchronized: () => signalDnsmasq(),
    },

    dhcp: {
      // Reservations are in dhcp-hostsdir (reread on SIGHUP); scopes are in
      // conf-dir (restart).
      applyScopes: (db, opts) =>
        apply(() => {
          const confChanged = regenerateScopeConfigs(db);
          const resChanged = regenerateReservations(db);
          return confChanged ? 'restart' : resChanged ? 'reload' : 'none';
        }, opts),
      async readLeases({ leaseFile = LEASE_FILE, ...settle } = {}) {
        const content = await readSettledLeaseFile({ leaseFile, ...settle });
        if (content === null) return { leases: null, unsettled: true };
        removeLegacyLeaseHosts();
        return { leases: parseLeaseFile(content) };
      },
      // Polled: fs.watch misses dnsmasq's in-place rewrites on some hosts.
      watchLeases(onChange) {
        try {
          fs.watchFile(LEASE_FILE, { interval: DHCP_LEASE_WATCH_MS }, () => onChange());
          console.log('Lease file watcher started:', LEASE_FILE);
        } catch (err) {
          console.warn('Could not watch lease file:', err.message);
        }
        return () => fs.unwatchFile(LEASE_FILE);
      },
      releaseLease: (lease) => releaseDnsmasqLease(lease),
      serverIdentity: () => ({ duid: readServerDuid() }),
    },

    // Router Advertisements come from the DHCPv6 scope files, so applyScopes
    // covers them; the role is here so RA can move to another daemon later.
    ra: {},

    status: () => ({
      name: 'dnsmasq',
      running: isDnsmasqRunning(),
      restartPending: dnsmasqRestartPending(),
    }),
    capabilities: () => ({
      dnssec: dnsmasqSupportsDnssec(),
      routerAdvertisements: true,
      dhcpv6: true,
      leaseRelease: true,
      encryptedUpstream: false,
    }),
    transaction: (fn) => withValidatedDnsmasqUpdate(fn),
    applyActivation,
    // Restart when asked to, when a previous restart failed (the running
    // process may hold an older config), or when OUR unit is down.
    activate({ force = false } = {}) {
      if (force || dnsmasqRestartPending() || !isCidrellaDnsmasqRunning()) {
        restartDnsmasq();
        return 'restarted';
      }
      return 'unchanged';
    },
    restart: () => restartDnsmasq(),
  };
}
