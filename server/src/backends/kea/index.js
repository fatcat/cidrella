/**
 * The Kea backend: DHCPv4 and DHCPv6 from ISC Kea 3, one daemon per family.
 * It fills the DHCP role only; dnsmasq keeps DNS and the Router
 * Advertisements. See backends/contract.js for what the operations promise.
 *
 * The configuration is file-canonical, like dnsmasq's: applyScopes renders
 * kea-dhcp4.conf and kea-dhcp6.conf from the database, `kea-dhcp4 -t`
 * checks them, and a reload makes the daemon read them. Leases live in Kea's
 * memfile and are read, added and released through the control API.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { DHCP_LEASE_WATCH_MS } from '../../config/defaults.js';
import { ipv6Enabled } from '../../utils/ipv6-support.js';
import { selectInterfaceNames } from '../../utils/interface-config.js';
import { normalizeDuid } from '../../utils/duid.js';
import { declareSupport } from '../features.js';
import { atomicWrite, createValidatedFiles } from '../shared/validated-files.js';
import { createUnitControl } from '../shared/unit-control.js';
import { findExecutable } from '../../utils/executable.js';
import { loadDhcpReservations, loadDhcpScopes } from '../shared/dhcp-scope-model.js';
import {
  FAMILIES,
  KEA_API_USER,
  KEA_DIR,
  KEA_LOG_DIR,
  RESTART_PENDING,
  SERVER_DUID_FILE,
  binary,
  confPath,
  controlPort,
  keaEnv,
  newestLegalLog,
  pruneLegalLogs,
  unitName,
  enableFlagPath,
} from './paths.js';
import { ensureKeaSecret, readKeaSecret } from './secret.js';
import { createKeaClient } from './client.js';
import { renderKeaConfig, serializeKeaConfig } from './render.js';
import {
  importKeaLeases,
  keaPacketCounters,
  leaseSignature,
  readKeaLeases,
  releaseKeaLease,
} from './leases.js';
import { createLegalLogParser, isLegalLine } from './legal-log-parser.js';

const ROLES = ['dhcp'];

// What CIDRella does through Kea. Router Advertisements and the names of
// SLAAC hosts stay with dnsmasq (the ra role), which Kea does not fill.
const SUPPORTED = [
  'dhcp-scopes',
  'dhcp-res-mac',
  'dhcp-relay',
  'dhcp-ping-check',
  'dhcp-options',
  'dhcp6-stateful',
  'dhcp6-stateless',
  'dhcp6-duid-res',
  'lease-release',
  'fingerprint',
  'forensic-log',
];

const NOTES = {
  'dhcp-ping-check': 'DHCPv4 only; Kea has no ping check for DHCPv6.',
  'dhcp-relay':
    'Kea picks the network from the relay address, so a relayed network needs no setting.',
  'dhcp-stats': 'Kea counts pool use; CIDRella does not show it yet.',
  'forensic-log': `Kea writes it under ${KEA_LOG_DIR}.`,
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `servesDhcp()` says whether Kea answers DHCP (backends/index.js); not
 * serving, it renders its configuration listening on no interface. The rest
 * of `deps` are for tests: `exec` replaces execFileSync for `-t`, `families`
 * the families served, `interfaces` and `sysIfaces` the host's, `fetchImpl`
 * the HTTP client, `access` the check that a binary can run, and `wait` the
 * pause between readiness checks.
 */
export function createKeaBackend(deps = {}) {
  const exec = deps.exec || execFileSync;
  const servesDhcp = deps.servesDhcp || (() => true);
  const families = deps.families || (() => (ipv6Enabled() ? [4, 6] : [4]));
  const interfaces = deps.interfaces || (() => selectInterfaceNames('dhcp').names);
  const sysIfaces = deps.sysIfaces || (() => os.networkInterfaces());
  const access =
    deps.access ||
    ((file) => {
      if (!findExecutable(file)) throw Object.assign(new Error(`${file} not found`), { code: 'ENOENT' });
    });
  const wait = deps.wait || pause;

  const commands = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      createKeaClient({
        port: controlPort(family),
        user: KEA_API_USER,
        password: () => readKeaSecret(),
        fetchImpl: deps.fetchImpl,
      }),
    ]),
  );
  const units = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      createUnitControl({
        unit: unitName(family),
        processName: `kea-dhcp${family}`,
        restartPendingFile: RESTART_PENDING,
        enableFile: enableFlagPath(family),
      }),
    ]),
  );

  // `kea-dhcp4 -t` with the same confinement the units run with. It checks
  // the syntax, options and subnets; Kea checks the lease and log paths only
  // when it starts, and those are fixed in paths.js.
  function validate() {
    for (const family of FAMILIES) {
      try {
        exec(binary(family), ['-t', confPath(family)], {
          stdio: 'pipe',
          env: { ...process.env, ...keaEnv() },
        });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          throw new Error(`Kea is not installed: ${binary(family)} was not found`);
        }
        const detail = err?.stderr?.toString?.().trim() || err?.stdout?.toString?.().trim();
        throw new Error(`kea-dhcp${family} refused the configuration: ${detail || err.message}`, {
          cause: err,
        });
      }
    }
  }

  const withValidatedKeaUpdate = createValidatedFiles({
    targets: () => FAMILIES.map(confPath),
    validate,
  });

  function serverDuid() {
    try {
      return normalizeDuid(fs.readFileSync(SERVER_DUID_FILE, 'utf8').trim()) || null;
    } catch {
      return null;
    }
  }

  function renderAll(db) {
    const served = servesDhcp() ? families() : [];
    const input = {
      scopes: loadDhcpScopes(db),
      reservations: loadDhcpReservations(db),
      sysIfaces: sysIfaces(),
      serverDuid: serverDuid(),
    };
    let changed = false;
    for (const family of FAMILIES) {
      // A family not served still gets a file, listening nowhere, so the
      // daemon (if started) serves nothing rather than old scopes.
      const content = serializeKeaConfig(
        renderKeaConfig(family, {
          ...input,
          interfaces: served.includes(family) ? interfaces() : [],
        }),
      );
      const file = confPath(family);
      let old = null;
      try {
        old = fs.readFileSync(file, 'utf8');
      } catch {
        /* first render */
      }
      if (content !== old) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        atomicWrite(file, content);
        changed = true;
      }
    }
    return changed;
  }

  const runningFamilies = () => families().filter((family) => units[family].isRunning());

  // A stopped daemon reads its file when it starts, so it needs no reload.
  function applyActivation(activation) {
    for (const family of families()) {
      if (activation === 'restart') units[family].restart();
      else if (activation === 'reload' && units[family].isRunning()) units[family].reload();
    }
  }

  return {
    name: 'kea',
    roles: ROLES,

    dhcp: {
      // Kea rereads its whole configuration on a reload (SIGHUP), sockets
      // included, so no change needs a restart.
      applyScopes(db, { activate = true } = {}) {
        const changed = withValidatedKeaUpdate(() => renderAll(db));
        const activation = changed ? 'reload' : 'none';
        if (activate) applyActivation(activation);
        return { changed, activation, activated: activate && changed };
      },
      readLeases: () => readKeaLeases(commands, families()),
      // Polled: Kea has no lease notification without a hook of our own.
      // The counters move whenever an address is handed out, declined or
      // reclaimed.
      watchLeases(onChange) {
        const last = new Map();
        // Families Kea did not answer for: a sync then (at boot, before Kea
        // is up) failed too, so answering again counts as a change.
        const unreachable = new Set();
        let busy = false;
        const poll = async () => {
          if (busy) return;
          busy = true;
          try {
            let changed = false;
            for (const family of families()) {
              const signature = await leaseSignature(commands[family]).catch(() => null);
              if (signature === null) {
                unreachable.add(family);
                continue;
              }
              if (unreachable.delete(family)) changed = true;
              if (last.has(family) && last.get(family) !== signature) changed = true;
              last.set(family, signature);
            }
            if (changed) onChange();
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(poll, DHCP_LEASE_WATCH_MS);
        poll();
        return () => clearInterval(timer);
      },
      releaseLease: (lease) => releaseKeaLease(commands, lease),
      // A handover: the leases go in while Kea listens nowhere, and the
      // server DUID they were handed out under goes in the file the next
      // render reads, so DHCPv6 clients renew with Kea rather than rebind.
      async importLeases(leases, { serverDuid = null, ...opts } = {}) {
        if (serverDuid) {
          fs.mkdirSync(path.dirname(SERVER_DUID_FILE), { recursive: true });
          atomicWrite(SERVER_DUID_FILE, `${serverDuid}\n`);
        }
        return importKeaLeases(commands, leases, { ...opts, families: families() });
      },
      serverIdentity: () => ({ duid: serverDuid() }),
      dhcpCounters: () => keaPacketCounters(commands, families()),
    },

    status: () => ({
      name: 'kea',
      running: runningFamilies().length === families().length,
      restartPending: units[4].restartPending(),
    }),
    capabilities: () => declareSupport(ROLES, SUPPORTED),
    capabilityNotes: () => NOTES,
    transaction: (fn) => withValidatedKeaUpdate(fn),
    applyActivation,
    activate({ force = false } = {}) {
      if (force || units[4].restartPending() || runningFamilies().length < families().length) {
        applyActivation('restart');
        return 'restarted';
      }
      return 'unchanged';
    },
    restart: () => applyActivation('restart'),
    stop() {
      for (const family of FAMILIES) units[family].stop();
    },
    // Whether the daemons can run here at all, for the switch's preflight.
    installed() {
      for (const family of families()) {
        try {
          access(binary(family));
        } catch {
          return { ok: false, reason: `Kea is not installed: ${binary(family)} was not found` };
        }
      }
      return { ok: true };
    },
    /**
     * Resolves once each daemon answers its control API and, when Kea
     * serves, has opened its sockets on every interface; rejects with the
     * reason otherwise. Kea retries a socket five times, five seconds apart
     * (render.js), so the wait covers that.
     */
    async awaitRunning({ timeoutMs = 40000, intervalMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (const family of families()) {
        let last = 'no answer';
        for (;;) {
          let sockets = null;
          try {
            const reply = await commands[family]('status-get');
            sockets = reply.arguments?.sockets?.status || 'unknown';
          } catch (err) {
            last = err.message;
          }
          if (sockets && (!servesDhcp() || sockets === 'ready')) break;
          if (sockets === 'failed') {
            throw new Error(`kea-dhcp${family} could not open its sockets`);
          }
          if (sockets) last = `sockets ${sockets}`;
          if (Date.now() >= deadline) {
            throw new Error(`kea-dhcp${family} is not ready: ${last}`);
          }
          await wait(intervalMs);
        }
      }
    },
    // Kea refuses a control-socket directory looser than 0750.
    prepare() {
      fs.mkdirSync(KEA_LOG_DIR, { recursive: true });
      fs.mkdirSync(keaEnv().KEA_CONTROL_SOCKET_DIR, { recursive: true, mode: 0o750 });
      fs.chmodSync(keaEnv().KEA_CONTROL_SOCKET_DIR, 0o750);
      fs.mkdirSync(KEA_DIR, { recursive: true });
      ensureKeaSecret();
    },
    // The legal log keeps as long as the audit log does.
    pruneLogs: (days) => pruneLegalLogs(days),
    // The DHCPv4 legal log, which the fingerprint watcher reads. Kea starts
    // a new file each day; the path is the newest. Kea answers no DNS, and
    // its DHCP message counts come from dhcpCounters.
    logSource: () => ({
      get path() {
        return newestLegalLog(4);
      },
      querySourceIp: () => null,
      dhcpDirection: () => null,
      isDhcpLine: isLegalLine,
      createDhcpParser: createLegalLogParser,
    }),
  };
}
