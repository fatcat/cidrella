/**
 * radvd, the Router Advertisement backend of the PowerDNS + Kea stack
 * (dnsmasq sends its own on the dnsmasq stack). It advertises each DHCPv6
 * scope's prefix on the DHCP interface that holds an address inside it, with
 * the flags, lifetimes and DNS options dnsmasq would send (render.js).
 *
 * radvd runs only while it has something to advertise: with no live DHCPv6
 * scope there is no configuration (radvd refuses an empty file) and it is
 * kept stopped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { networkContains } from '../../utils/cidr.js';
import { selectInterfaceNames } from '../../utils/interface-config.js';
import { findExecutable } from '../../utils/executable.js';
import { declareSupport } from '../features.js';
import { atomicWrite, createValidatedFiles } from '../shared/validated-files.js';
import { createUnitControl } from '../shared/unit-control.js';
import { loadDhcpScopes } from '../shared/dhcp-scope-model.js';
import {
  ENABLE_FILE,
  RADVD_CONF,
  RADVD_DIR,
  RADVD_PID,
  RESTART_PENDING,
  UNIT,
  radvdBinary,
} from './paths.js';
import { renderRadvdConfig } from './render.js';

const ROLES = ['ra'];
const SUPPORTED = ['ra'];
const NOTES = {
  'ra-names':
    'radvd advertises prefixes only; dnsmasq guesses SLAAC hosts’ addresses to name them.',
};

// Written when no scope needs advertising: comment-only, which radvd would
// refuse, so it is never validated or run.
const IDLE = '# No DHCPv6 scope to advertise; radvd stays stopped.\n';

function readMtu(name) {
  try {
    const mtu = parseInt(fs.readFileSync(`/sys/class/net/${name}/mtu`, 'utf8'), 10);
    return Number.isFinite(mtu) && mtu > 0 ? mtu : null;
  } catch {
    return null;
  }
}

/**
 * `deps` are for tests: `exec` replaces execFileSync (radvd's config check),
 * `sysIfaces` the host's interfaces, `readMtu` an interface's MTU, and
 * `access` the check that the binary can run.
 */
export function createRadvdBackend(deps = {}) {
  const exec = deps.exec || execFileSync;
  const sysIfaces = deps.sysIfaces || (() => os.networkInterfaces());
  const mtuOf = deps.readMtu || readMtu;
  const access = deps.access || ((file) => findExecutable(file));

  const unit = createUnitControl({
    unit: UNIT,
    processName: 'radvd',
    pidFile: RADVD_PID,
    restartPendingFile: RESTART_PENDING,
    enableFile: ENABLE_FILE,
  });

  // Is there anything to advertise in the file on disk?
  function wanted() {
    try {
      return /^interface /m.test(fs.readFileSync(RADVD_CONF, 'utf8'));
    } catch {
      return false;
    }
  }

  function validate() {
    if (!wanted()) return;
    try {
      exec(radvdBinary(), ['--configtest', `--config=${RADVD_CONF}`], { stdio: 'pipe' });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new Error(`radvd is not installed: ${radvdBinary()} was not found`);
      }
      const detail = err?.stderr?.toString?.().trim() || err?.stdout?.toString?.().trim();
      throw new Error(`radvd refused the configuration: ${detail || err.message}`, { cause: err });
    }
  }

  const transaction = createValidatedFiles({ targets: () => [RADVD_CONF], validate });

  // Each live DHCPv6 scope on the DHCP interface holding an address inside
  // it. A scope no interface matches is advertised nowhere, as with dnsmasq,
  // which also picks the interface by its addresses; it is named in the log.
  function links(db) {
    const ifaces = sysIfaces();
    const { names } = selectInterfaceNames('dhcp', { sysIfaces: ifaces });
    const byName = new Map(names.map((name) => [name, []]));
    for (const scope of loadDhcpScopes(db)) {
      if (scope.family !== 6) continue;
      const cidr = `${scope.network}/${scope.prefix}`;
      const owner = names.find((name) =>
        (ifaces[name] || []).some(
          (addr) => addr.family === 'IPv6' && networkContains(cidr, addr.address),
        ),
      );
      if (owner) byName.get(owner).push(scope);
      else console.warn(`radvd: no DHCP interface has an address in ${cidr}; not advertised`);
    }
    return [...byName].map(([name, scopes]) => ({ name, mtu: mtuOf(name), scopes }));
  }

  function applyRouterAdvertisements(db, { activate = true } = {}) {
    const result = transaction(() => {
      const content = renderRadvdConfig(links(db)) ?? IDLE;
      let old = null;
      try {
        old = fs.readFileSync(RADVD_CONF, 'utf8');
      } catch {
        /* first write */
      }
      if (old === content) return { changed: false, activation: 'none' };
      fs.mkdirSync(RADVD_DIR, { recursive: true, mode: 0o750 });
      atomicWrite(RADVD_CONF, content);
      return { changed: true, activation: 'reload' };
    });
    const applied = { ...result, activated: activate && result.changed };
    return activate ? applyActivation(result.activation).then(() => applied) : applied;
  }

  // radvd re-reads its file on SIGHUP; one with nothing to advertise is
  // stopped instead, and a stopped one is started.
  async function applyActivation(activation) {
    if (activation === 'none') return;
    if (!wanted()) {
      await unit.stop();
      return;
    }
    if (activation === 'reload' && (await unit.isRunning())) await unit.reload();
    else await unit.restart();
  }

  return {
    name: 'radvd',
    label: 'radvd',
    roles: ROLES,
    ra: { applyRouterAdvertisements },
    status: async () => ({
      name: 'radvd',
      label: 'radvd',
      running: await unit.isRunning(),
      restartPending: unit.restartPending(),
      // Stopped on purpose while there is nothing to advertise.
      idle: !wanted(),
    }),
    capabilities: () => declareSupport(ROLES, SUPPORTED),
    capabilityNotes: () => NOTES,
    transaction: (fn) => transaction(fn),
    applyActivation,
    async activate({ force = false } = {}) {
      if (!wanted()) {
        if (await unit.isRunning()) await unit.stop();
        return 'unchanged';
      }
      if (force || unit.restartPending() || !(await unit.isRunning())) {
        await unit.restart();
        return 'restarted';
      }
      return 'unchanged';
    },
    restart: () => (wanted() ? unit.restart() : unit.stop()),
    stop: () => unit.stop(),
    awaitStopped: (opts) => unit.awaitStopped(opts),
    async awaitRunning({ timeoutMs = 10000, intervalMs = 250 } = {}) {
      if (!wanted()) return;
      const deadline = Date.now() + timeoutMs;
      while (!(await unit.isRunning())) {
        if (Date.now() >= deadline) throw new Error('radvd is not running');
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    // A stack switch: the configuration written, radvd not started (dnsmasq
    // still sends the Router Advertisements until it stops).
    async stage(db) {
      applyRouterAdvertisements(db, { activate: false });
    },
    installed() {
      return access(radvdBinary())
        ? { ok: true }
        : { ok: false, reason: `radvd is not installed: ${radvdBinary()} was not found` };
    },
    prepare() {
      fs.mkdirSync(RADVD_DIR, { recursive: true, mode: 0o750 });
      fs.mkdirSync(path.dirname(ENABLE_FILE), { recursive: true });
    },
    logSource: () => null,
  };
}
