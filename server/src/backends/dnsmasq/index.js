/**
 * The dnsmasq backend: one process serving DNS, DHCP (v4 and v6) and Router
 * Advertisements. Each operation wraps the generators in this directory; see
 * backends/contract.js for what the operations promise.
 */
import fs from 'fs';
import { DHCP_LEASE_WATCH_MS } from '../../config/defaults.js';
import { CONF_DIR, DHCP_HOSTS_DIR, HOSTS_DIR } from './paths.js';
import {
  applyInterfaceConfig,
  dnsmasqRestartPending,
  dnsmasqSupportsDnssec,
  isCidrellaDnsmasqRunning,
  regenerateConfDir,
  regenerateDnsmasqConf,
  regenerateHostsDir,
  restartDnsmasq,
  servedRecordTtl,
  signalDnsmasq,
  withValidatedDnsmasqUpdate,
} from './dnsmasq.js';
import {
  formatLeaseFile,
  parseLeaseFile,
  regenerateReservations,
  regenerateScopeConfigs,
} from './dhcp.js';
import { removeLegacyLeaseHosts, retireLegacyBlocklistConf } from './legacy.js';
import { LEASE_FILE, readServerDuid, readSettledLeaseFile } from './lease-file.js';
import { releaseDnsmasqLease } from './lease-release.js';
import { LOG_FILE, dhcpDirection, isDhcpLine, querySourceIp } from './log-format.js';
import { createDhcpLogParser } from './dhcp-log-parser.js';
import { declareSupport } from '../features.js';
import { atomicWrite } from '../shared/validated-files.js';

const ROLES = ['dns', 'dhcp', 'ra'];

// What CIDRella does through dnsmasq today. dnsmasq could do more (CAA,
// conditional forwarding, cache tuning); a feature turns true here when
// CIDRella renders it, not when dnsmasq has the directive.
const SUPPORTED = [
  'dns-core-records',
  'dns-local-zones',
  'rec-forwarders',
  'dhcp-scopes',
  'dhcp-res-mac',
  'dhcp-ping-check',
  'dhcp-options',
  'dhcp6-stateful',
  'dhcp6-stateless',
  'dhcp6-duid-res',
  'ra',
  'ra-names',
  'lease-release',
  'fingerprint',
];

const NOTES = {
  'dns-record-ttl': 'dnsmasq answers every record but a CNAME with one TTL (local-ttl).',
  'dns-soa-ns': 'dnsmasq serves SOA and NS records only in its authoritative mode.',
  'dhcp-stats': 'dnsmasq has no statistics interface.',
  'forensic-log': 'dnsmasq keeps no DHCP audit log of its own.',
};

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

/**
 * `servesDhcp()` says whether dnsmasq answers DHCP or only sends the Router
 * Advertisements while another backend serves (backends/index.js).
 */
export function createDnsmasqBackend({ servesDhcp = () => true } = {}) {
  // Scopes are in conf-dir (restart); reservations in dhcp-hostsdir (reread
  // on SIGHUP). Not serving, the same files carry the RA only.
  const applyScopes = (db, opts) =>
    apply(() => {
      const serving = servesDhcp();
      const confChanged = regenerateScopeConfigs(db, { serving });
      const resChanged = regenerateReservations(db, { serving });
      return confChanged ? 'restart' : resChanged ? 'reload' : 'none';
    }, opts);

  return {
    name: 'dnsmasq',
    roles: ROLES,

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
      servedTtl: (record) => servedRecordTtl(record),
      // Optional op: clear what older releases left behind.
      retireLegacyArtifacts: () => retireLegacyBlocklistConf(),
    },

    dhcp: {
      applyScopes,
      async readLeases({ leaseFile = LEASE_FILE, ...settle } = {}) {
        // dnsmasq writes the file on its first lease: none yet is not a
        // read caught mid-rewrite.
        if (!fs.existsSync(leaseFile)) return { leases: null, absent: true };
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
      // A handover: dnsmasq reads its lease file only when it starts, so the
      // file is written while it answers no DHCP and the restart that makes
      // it serve again loads it. The server DUID line keeps the DUID clients
      // know, so they renew rather than rebind.
      async importLeases(leases, { serverDuid = null, leaseFile = LEASE_FILE } = {}) {
        atomicWrite(leaseFile, formatLeaseFile(leases, { serverDuid }));
        return { added: leases.length, failed: [] };
      },
    },

    // The Router Advertisements come from the DHCPv6 scope files. While
    // dnsmasq serves DHCP, applyScopes writes them; while another backend
    // does, this does (the same files, answering no request).
    ra: {
      applyRouterAdvertisements: applyScopes,
    },

    status: () => ({
      name: 'dnsmasq',
      running: isCidrellaDnsmasqRunning(),
      restartPending: dnsmasqRestartPending(),
    }),
    capabilities: () =>
      declareSupport(ROLES, [
        ...SUPPORTED,
        ...(dnsmasqSupportsDnssec() ? ['rec-dnssec-validate'] : []),
      ]),
    capabilityNotes: () =>
      dnsmasqSupportsDnssec()
        ? NOTES
        : { ...NOTES, 'rec-dnssec-validate': 'This dnsmasq build has no DNSSEC support.' },
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
    // Started by restart(), which returns once systemd has it running.
    async awaitRunning() {
      if (!isCidrellaDnsmasqRunning()) throw new Error('dnsmasq is not running');
    },
    // The directories dnsmasq.conf points hostsdir, dhcp-hostsdir and
    // conf-dir at; dnsmasq refuses to start without them.
    prepare() {
      for (const dir of [HOSTS_DIR, DHCP_HOSTS_DIR, CONF_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
      }
    },
    // dnsmasq logs queries (log-queries) and DHCP detail (log-dhcp) to one file.
    logSource: () => ({
      path: LOG_FILE,
      querySourceIp,
      dhcpDirection,
      isDhcpLine,
      createDhcpParser: createDhcpLogParser,
    }),
  };
}
