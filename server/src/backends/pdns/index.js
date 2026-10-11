/**
 * The PowerDNS backend: the DNS role from PowerDNS Authoritative (CIDRella's
 * zones) and Recursor (everything else, through CIDRella's forwarder). It
 * sits where dnsmasq does: behind the DNS proxy on the internal port, or on
 * the LAN port in bypass mode. See docs/DNSMASQ-COUPLING.md, "PowerDNS".
 *
 * Zones go to Authoritative through its HTTP API, which also clears its
 * cache; Authoritative's sqlite database is derived and never backed up.
 * Recursor's configuration is a file, recursor.yml, checked by Recursor
 * before it is kept. After a zone changes, Recursor's cache under it is
 * wiped, so the next query sees the change.
 *
 * applyZones returns a Promise (the API is HTTP); applyResolver and
 * applyListen write only recursor.yml and return at once.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import {
  ENCRYPTED_FORWARDER_PORT,
  RECURSOR_NETWORK_TIMEOUT_MS,
  backendDnsPort,
} from '../../config/defaults.js';
import { getDb, getSetting } from '../../db/init.js';
import { ipv6Enabled } from '../../utils/ipv6-support.js';
import { listenableAddresses, selectInterfaceNames } from '../../utils/interface-config.js';
import { findExecutable } from '../../utils/executable.js';
import { getNtpStatus } from '../../utils/ntp-status.js';
import { declareSupport } from '../features.js';
import { atomicWrite, createValidatedFiles } from '../shared/validated-files.js';
import { createUnitControl } from '../shared/unit-control.js';
import { ensureSecret, readSecret } from '../shared/secret.js';
import { loadDnsZones } from '../shared/dns-zone-model.js';
import {
  API_KEY_FILE,
  AUTH_CONF,
  AUTH_DB,
  AUTH_DIR,
  DAEMONS,
  PDNS_DIR,
  RECURSOR_CONF,
  RECURSOR_DIR,
  RESTART_PENDING,
  RUN_DIR,
  SECRET_DIR,
  authApiPort,
  authDnsPort,
  binary,
  enableFlagPath,
  processName,
  recControlBinary,
  sqliteSchemaPath,
  unitName,
} from './paths.js';
import { createPdnsClient } from './client.js';
import { desiredZones, renderAuthConfig, renderRecursorConfig, servedTtl } from './render.js';
import { diffZones } from './diff.js';
import { forwardedAddresses, reservedLocalDomains } from '../shared/reserved-zones.js';

const ROLES = ['dns'];

const SUPPORTED = [
  'dns-core-records',
  'dns-local-zones',
  'dns-record-ttl',
  'dns-soa-ns',
  'rec-forwarders',
  'rec-dnssec-validate',
];

const NOTES = {
  'dns-local-zones':
    'A zone set to forward unknown names upstream gets them from the forwarder through the ' +
    'DNS proxy: not in bypass mode, and without DNSSEC validation of that answer.',
};

// Recursor answers these itself (localhost and the loopback reverse names);
// an empty zone for them in Authoritative would hide that.
const RECURSOR_BUILTIN = new Set(['localhost', '127.in-addr.arpa', `1.${'0.'.repeat(31)}ip6.arpa`]);

// The reserved names Authoritative holds an empty zone for, so Recursor
// answers them locally, as dnsmasq's local= lines do.
const reservedZones = () =>
  reservedLocalDomains({ addresses: forwardedAddresses() }).filter(
    (domain) => !RECURSOR_BUILTIN.has(domain),
  );

const ORDER = ['none', 'reload', 'restart'];
const larger = (a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// recursor.yml carries a digest of each part, so the next write knows whether
// a reload is enough without remembering anything across restarts.
const digestLine = (part, text) => `# ${part}: ${sha(text)}`;
function digestsIn(content) {
  const read = (part) => new RegExp(`^# ${part}: (\\w+)$`, 'm').exec(content || '')?.[1] ?? null;
  return { fixed: read('fixed'), zones: read('zones') };
}

/**
 * `deps` are for tests: `exec` replaces execFileSync (Recursor's config
 * check and rec_control), `fetchImpl` the HTTP client, `sysIfaces` the
 * host's interfaces, `access` the check that a binary can run, `ntpStatus`
 * the clock, `getDb` the database a restart resyncs from, and `wait` the
 * pause between readiness checks.
 */
export function createPdnsBackend(deps = {}) {
  const exec = deps.exec || execFileSync;
  const sysIfaces = deps.sysIfaces || (() => os.networkInterfaces());
  const ntpStatus = deps.ntpStatus || getNtpStatus;
  const currentDb = deps.getDb || getDb;
  const wait = deps.wait || pause;
  const access =
    deps.access ||
    ((file) => {
      if (!findExecutable(file))
        throw Object.assign(new Error(`${file} not found`), { code: 'ENOENT' });
    });

  const api = createPdnsClient({
    port: authApiPort(),
    apiKey: () => readSecret(SECRET_DIR, API_KEY_FILE),
    fetchImpl: deps.fetchImpl,
  });
  const units = Object.fromEntries(
    DAEMONS.map((daemon) => [
      daemon,
      createUnitControl({
        unit: unitName(daemon),
        processName: processName(daemon),
        restartPendingFile: RESTART_PENDING,
        enableFile: enableFlagPath(daemon),
      }),
    ]),
  );

  // Set once timesync.js reports the clock synchronized.
  let clockSynchronized = false;
  // Zones whose answers changed and whose part of Recursor's cache is still
  // to be wiped (an apply with activate: false leaves it to applyActivation).
  const pendingWipes = new Set();
  // Zone writes run one at a time, each against what the one before left.
  let zoneQueue = Promise.resolve();

  function recControl(...args) {
    return exec(recControlBinary(), [`--socket-dir=${RUN_DIR}`, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  }

  function validateRecursor() {
    try {
      exec(binary('recursor'), [`--config-dir=${RECURSOR_DIR}`, '--config=check'], {
        stdio: 'pipe',
      });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new Error(`PowerDNS Recursor is not installed: ${binary('recursor')} was not found`);
      }
      const detail = err?.stderr?.toString?.().trim() || err?.stdout?.toString?.().trim();
      throw new Error(`pdns_recursor refused the configuration: ${detail || err.message}`, {
        cause: err,
      });
    }
  }

  const withValidatedRecursorUpdate = createValidatedFiles({
    targets: () => [RECURSOR_CONF],
    validate: validateRecursor,
  });

  // DNSSEC off: Recursor neither validates nor fails anything. On, it
  // validates once the clock is right; before that it only logs ('process'),
  // as dnsmasq starts with dnssec-no-timecheck. Without timedatectl (Docker)
  // the container shares the host's clock and validates from the start.
  function validationMode() {
    if (getSetting('dnssec_enabled') !== 'true') return 'process-no-validate';
    if (clockSynchronized) return 'validate';
    const ntp = ntpStatus();
    return !ntp.available || ntp.synchronized ? 'validate' : 'process';
  }

  // Where Recursor listens: the proxy's internal port on loopback, or in
  // bypass mode the LAN port on loopback and the DNS interfaces. With DNS
  // switched off the proxy is down and Recursor keeps to loopback.
  function listenPlan() {
    const ifaces = sysIfaces();
    const bypass =
      getSetting('dns_proxy_bypass') === 'true' && getSetting('dns_enabled') !== 'false';
    const listen = ['127.0.0.1'];
    if (ipv6Enabled() && ifaces.lo?.some((a) => a.family === 'IPv6')) listen.push('::1');
    if (bypass) {
      const { names } = selectInterfaceNames('dns', { sysIfaces: ifaces });
      for (const name of names) listen.push(...listenableAddresses(ifaces[name]));
    }
    return {
      listen: [...new Set(listen)],
      port: backendDnsPort({ listenPort: getSetting('dns_listen_port'), bypass }),
    };
  }

  // Render recursor.yml; the activation it calls for.
  function writeRecursor(db) {
    return withValidatedRecursorUpdate(() => {
      const zones = [...desiredZones(loadDnsZones(db), { reserved: reservedZones() }).keys()];
      const rendered = renderRecursorConfig({
        zones,
        ...listenPlan(),
        authPort: authDnsPort(),
        forwarderPort: ENCRYPTED_FORWARDER_PORT,
        recursion: getSetting('dns_no_recursion') !== 'true',
        validation: validationMode(),
        networkTimeoutMs: RECURSOR_NETWORK_TIMEOUT_MS,
        runDir: RUN_DIR,
      });
      const content = [
        digestLine('fixed', rendered.fixed),
        digestLine('zones', rendered.zones),
        rendered.text,
      ].join('\n');
      let old = null;
      try {
        old = fs.readFileSync(RECURSOR_CONF, 'utf8');
      } catch {
        /* first render */
      }
      if (content === old) return { changed: false, activation: 'none' };
      fs.mkdirSync(RECURSOR_DIR, { recursive: true });
      atomicWrite(RECURSOR_CONF, content);
      const before = digestsIn(old);
      const activation =
        before.fixed !== sha(rendered.fixed)
          ? 'restart'
          : before.zones !== sha(rendered.zones)
            ? 'reload'
            : 'none';
      return { changed: activation !== 'none', activation };
    });
  }

  // Make Authoritative hold the desired zones. A zone the API refuses does
  // not stop the others; the error names every zone that failed.
  async function syncZones(db) {
    const desired = desiredZones(loadDnsZones(db), { reserved: reservedZones() });
    const current = new Map();
    for (const zone of await api.listZones()) {
      current.set(
        zone.name,
        desired.has(zone.name) ? await api.getZone(zone.id) : { id: zone.id, name: zone.name },
      );
    }
    const plan = diffZones(desired, current);
    const failed = [];
    const attempt = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        failed.push(`${name} (${err.message})`);
      }
    };
    for (const zone of plan.creates) await attempt(zone.name, () => api.createZone(zone));
    for (const patch of plan.patches) {
      await attempt(patch.name, () => api.patchZone(patch.id, patch.rrsets));
    }
    for (const zone of plan.deletes) await attempt(zone.name, () => api.deleteZone(zone.id));
    for (const name of plan.changedZones) pendingWipes.add(name);
    if (failed.length) {
      throw new Error(`PowerDNS refused zone changes: ${failed.join('; ')}`);
    }
    return plan;
  }

  // Recursor takes new forward zones and their trust anchors without a
  // restart: the anchors first, or a new zone answers Bogus until they come.
  // Then the cache under each changed zone goes. Recursor not running has
  // no cache to wipe.
  function reloadRecursor() {
    try {
      recControl('reload-lua-config');
      recControl('reload-zones');
      for (const zone of pendingWipes) recControl('wipe-cache', `${zone.replace(/\.$/, '')}$`);
    } catch (err) {
      const detail = err?.stderr?.toString?.().trim() || err.message;
      console.warn(`rec_control failed (Recursor may not be running): ${detail}`);
    }
    pendingWipes.clear();
  }

  // Authoritative's API answers.
  async function awaitAuthoritative({ timeoutMs = 30000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await api.server();
        return;
      } catch (err) {
        if (Date.now() >= deadline) {
          throw new Error(`PowerDNS Authoritative is not ready: ${err.message}`);
        }
      }
      await wait(intervalMs);
    }
  }

  // Start (or restart) the daemons in `which`, Authoritative first: once its
  // API answers, the zones are synced, and only then does Recursor start, so
  // it never caches a negative answer from an empty Authoritative. A sync
  // that fails still starts Recursor (forwarding works without the zones).
  // Never another restart from here, so an API that keeps dropping cannot
  // loop. Resolves once Recursor has been started.
  async function startDaemons(which = DAEMONS) {
    pendingWipes.clear();
    if (which.includes('auth')) {
      units.auth.restart();
      try {
        await awaitAuthoritative();
        // Through the zone queue, behind any write already under way.
        await dns.applyZones(currentDb(), { activate: false });
      } catch (err) {
        console.warn('PowerDNS zone sync after start failed:', err.message);
      }
    }
    if (which.includes('recursor')) units.recursor.restart();
    pendingWipes.clear();
  }

  function restartAll() {
    return startDaemons().catch((err) => console.warn('PowerDNS start failed:', err.message));
  }

  // A restart restarts Recursor only: Authoritative takes zones through its
  // API, and its own configuration changes only in prepare().
  function applyActivation(activation) {
    if (activation === 'restart') {
      units.recursor.restart();
      pendingWipes.clear();
    } else if (activation === 'reload') {
      reloadRecursor();
    }
  }

  async function awaitRunning({ timeoutMs = 30000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let last;
      try {
        await api.server();
        recControl('ping');
        return;
      } catch (err) {
        last = err?.stderr?.toString?.().trim() || err.message;
      }
      if (Date.now() >= deadline) throw new Error(`PowerDNS is not ready: ${last}`);
      await wait(intervalMs);
    }
  }

  // The recursor.yml write and its activation, for applyResolver and applyListen.
  function applyRecursor(db, { activate = true } = {}) {
    const { changed, activation } = writeRecursor(db);
    if (activate) applyActivation(activation);
    return { changed, activation, activated: activate && changed };
  }

  const dns = {
    // The forward zones in recursor.yml follow the zone list, so a zone
    // write renders it too. Authoritative not answering (stopped, or not
    // started yet) needs a start; activate() resyncs once it is up.
    applyZones(db, { activate = true } = {}) {
      const run = async () => {
        const recursor = writeRecursor(db);
        let plan;
        try {
          plan = await syncZones(db);
        } catch (err) {
          if (err.name === 'PdnsError' && err.status === null) {
            if (activate) restartAll();
            return { changed: true, activation: 'restart', activated: activate };
          }
          throw err;
        }
        const zonesChanged = plan.changedZones.length > 0;
        const activation = larger(recursor.activation, zonesChanged ? 'reload' : 'none');
        const changed = activation !== 'none';
        if (activate) applyActivation(activation);
        return { changed, activation, activated: activate && changed };
      };
      const result = zoneQueue.then(run, run);
      zoneQueue = result.catch(() => {});
      return result;
    },
    applyResolver: applyRecursor,
    applyListen: applyRecursor,
    onClockSynchronized() {
      clockSynchronized = true;
      applyRecursor(currentDb());
    },
    servedTtl: (record) => servedTtl(record),
    // Authoritative answers NXDOMAIN for a name it has no record for; the
    // DNS proxy asks the forwarder again under a forward-unknown zone.
    forwardsUnknownItself: false,
  };

  return {
    name: 'pdns',
    label: 'PowerDNS',
    roles: ROLES,
    dns,

    status: () => ({
      name: 'pdns',
      label: 'PowerDNS',
      running: DAEMONS.every((daemon) => units[daemon].isRunning()),
      restartPending: units.auth.restartPending(),
    }),
    capabilities: () => declareSupport(ROLES, SUPPORTED),
    capabilityNotes: () => NOTES,
    transaction: (fn) => withValidatedRecursorUpdate(fn),
    applyActivation,
    // A forced or pending restart restarts both; otherwise only a daemon
    // that is down starts.
    activate({ force = false } = {}) {
      const down = DAEMONS.filter((daemon) => !units[daemon].isRunning());
      if (force || units.auth.restartPending()) {
        restartAll();
        return 'restarted';
      }
      if (down.length) {
        startDaemons(down).catch((err) => console.warn('PowerDNS start failed:', err.message));
        return 'restarted';
      }
      return 'unchanged';
    },
    restart: () => restartAll(),
    stop() {
      for (const daemon of DAEMONS) units[daemon].stop();
    },
    async awaitStopped(opts) {
      for (const daemon of DAEMONS) await units[daemon].awaitStopped(opts);
    },
    installed() {
      for (const file of [binary('auth'), binary('recursor'), recControlBinary()]) {
        try {
          access(file);
        } catch {
          return { ok: false, reason: `PowerDNS is not installed: ${file} was not found` };
        }
      }
      if (!sqliteSchemaPath()) {
        return { ok: false, reason: 'PowerDNS is not installed: no gsqlite3 schema was found' };
      }
      return { ok: true };
    },
    awaitRunning,
    /**
     * A stack switch, before the other stack stops: Authoritative started
     * with the zones and recursor.yml written, Recursor left stopped (its
     * port is the other stack's until then). activate() starts it after.
     */
    async stage(db) {
      withValidatedRecursorUpdate(() => {
        dns.applyListen(db, { activate: false });
        dns.applyResolver(db, { activate: false });
      });
      units.auth.restart();
      await awaitAuthoritative();
      // Unlike a start, a zone the API refuses fails the stage.
      await dns.applyZones(db, { activate: false });
    },
    // The directories, the API key, Authoritative's database (created from
    // the gsqlite3 schema when missing) and pdns.conf. A changed pdns.conf
    // takes effect at the next activate().
    prepare() {
      for (const dir of [PDNS_DIR, AUTH_DIR, RECURSOR_DIR, RUN_DIR]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      }
      const apiKey = ensureSecret(SECRET_DIR, API_KEY_FILE);
      if (!fs.existsSync(AUTH_DB)) {
        const schema = sqliteSchemaPath();
        if (!schema) throw new Error('PowerDNS is not installed: no gsqlite3 schema was found');
        // An empty file is a new database to SQLite; creating it first sets
        // the mode, and SQLite gives its journal the same one.
        fs.writeFileSync(AUTH_DB, '', { mode: 0o600 });
        const pdnsDb = new Database(AUTH_DB);
        try {
          pdnsDb.exec(fs.readFileSync(schema, 'utf8'));
        } finally {
          pdnsDb.close();
        }
      }
      const conf = renderAuthConfig({
        dbPath: AUTH_DB,
        port: authDnsPort(),
        apiPort: authApiPort(),
        apiKey,
        runDir: RUN_DIR,
      });
      let old = null;
      try {
        old = fs.readFileSync(AUTH_CONF, 'utf8');
      } catch {
        /* first render */
      }
      if (conf !== old) {
        atomicWrite(AUTH_CONF, conf, { mode: 0o600 });
        if (old !== null) {
          fs.mkdirSync(path.dirname(RESTART_PENDING), { recursive: true });
          fs.writeFileSync(RESTART_PENDING, new Date().toISOString());
        }
      }
    },
    // The proxy logs every query itself; PowerDNS's own log is not read yet.
    logSource: () => null,
  };
}
