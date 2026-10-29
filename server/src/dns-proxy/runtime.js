/**
 * The DNS proxy's state and its answers to the web app's messages
 * (protocol.js), apart from any process: main.js runs it behind the Unix
 * socket, and the tests run it in their own process in place of the web
 * app's client (tests/helpers/proxy-in-process.js), so both drive the same
 * code.
 *
 *   dbFile    the database to open read-only (a path, or a function giving one)
 *   send      (message, opts) to the web app
 *   reports   { queryRow, liveness, resolution } for what the proxy saw
 *   onShutdown  the web app asked the proxy to exit
 */
import fs from 'fs';
import { proxyLog } from './log.js';
import * as Db from './db.js';
import { PROTOCOL_VERSION, metricsToWire } from './protocol.js';
import * as Server from './server.js';
import * as Forwarder from './forwarder.js';

// A release a restore asked for ends at the restored web app's hello, or
// after this, whichever comes first.
const DB_RELEASE_MAX_MS = 120_000;

// Which file a path is now: device and inode, or 'missing'.
function identity(file) {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

export function createProxyRuntime({
  dbFile,
  send,
  reports,
  onShutdown = () => {},
  dbRetryMs = 5000,
  codeId = null,
  pid = process.pid,
}) {
  const fileNow = typeof dbFile === 'function' ? dbFile : () => dbFile;
  const dbIdentity = (file) => [identity(file), identity(`${file}-shm`)].join(' ');

  // The database, opened when it can be: the web app creates it, so a first
  // boot may start the proxy before it exists. Closed while a restore swaps
  // the files (`releasedUntil`).
  let lastDbTry = 0;
  let openedAs = null;
  let releasedUntil = 0;
  function database() {
    if (Date.now() < releasedUntil) return null;
    let file;
    try {
      file = fileNow();
    } catch {
      return null;
    }
    if (!file) return null;
    const open = Db.proxyDb();
    if (open && Db.proxyDbFile() === file) return open;
    if (open) Db.closeProxyDb();
    const now = Date.now();
    if (now - lastDbTry < dbRetryMs) return null;
    lastDbTry = now;
    try {
      const opened = Db.openProxyDb(file);
      openedAs = dbIdentity(file);
      return opened;
    } catch (err) {
      proxyLog('warn', 'Could not open the database read-only', { file, error: err.message });
      return null;
    }
  }

  // Closed until the next web app's hello: a restore or rollback is about to
  // put other files in its place.
  function releaseDb() {
    releasedUntil = Date.now() + DB_RELEASE_MAX_MS;
    Db.closeProxyDb();
    proxyLog('info', 'Closed the database for a restore');
  }

  // A database file replaced under the open connection (a restore, an
  // operator's copy) would keep the proxy reading the old one: open the file
  // now there instead.
  function checkDbFile() {
    const file = Db.proxyDbFile();
    if (!Db.proxyDb() || dbIdentity(file) === openedAs) return;
    proxyLog('info', 'The database file changed, opening it again');
    Db.closeProxyDb();
    lastDbTry = 0;
    database();
  }

  const settings = {
    setting: (key) => {
      database();
      return Db.setting(key);
    },
    cachedSetting: (key) => {
      database();
      return Db.cachedSetting(key);
    },
  };

  Server.configureProxyServer({
    ...settings,
    db: database,
    queryRow: reports.queryRow,
    liveness: reports.liveness,
    resolution: reports.resolution,
  });
  Forwarder.configureForwarder({ setting: settings.setting });

  // What the web app said, as last applied: { proxy, defaults, serve }.
  let current = null;

  const listenKey = (config) =>
    JSON.stringify([
      config?.serve !== false,
      config?.proxy?.listenAddresses,
      config?.proxy?.listenPort,
      config?.proxy?.dnsOff,
    ]);

  function applyConfig(next, { rebind = false } = {}) {
    const changed = listenKey(current) !== listenKey(next);
    // Bound to nothing though it should serve: a bind that failed at start,
    // while something else still held the LAN port. The web app's config is
    // the moment to try again.
    const deaf = next.serve !== false && Server.serverStatus().sockets === 0;
    current = next;
    Db.setSettingDefaults(next.defaults || {});
    Server.setProxyConfig(next.proxy || {});
    if (!changed && !rebind && !deaf) return;
    Server.stopServing();
    if (next.serve !== false) Server.startServing();
  }

  function statusMessage() {
    return {
      type: 'status',
      pid,
      codeId,
      serve: current ? current.serve !== false : false,
      server: Server.serverStatus(),
      forwarder: Forwarder.getEncryptedForwarderStatus(),
      geoipLoaded: Server.isGeoipLoaded(),
      dbOpen: Db.proxyDb() !== null,
      // Which file it has open (device:inode of the database and its -shm).
      dbIdentity: Db.proxyDb() ? openedAs : null,
    };
  }

  const RELOADERS = {
    all: () => Server.reloadAll(),
    blocklist: () => Server.loadBlocklist(),
    allowlist: () => Server.loadAllowlist(),
    'filtering-overrides': () => Server.loadFilteringOverrides(),
    'geoip-rules': () => Server.loadGeoipRules(),
    'geoip-allowlist': () => Server.loadGeoipAllowlist(),
    mmdb: (message) => Server.loadMmdbFrom(message.path || undefined),
    'unload-mmdb': () => Server.unloadMmdb(),
    'reset-stats': () => Server.resetStats(),
  };

  async function handle(message) {
    switch (message.type) {
      case 'hello':
        // A web app saying hello is past any restore; open the database again.
        releasedUntil = 0;
        send({ type: 'hello', v: PROTOCOL_VERSION, codeId, pid }, { always: true });
        return;
      case 'config':
        applyConfig(message.config, { rebind: message.rebind === true });
        return;
      case 'reload': {
        const reload = RELOADERS[message.what];
        if (!reload) {
          proxyLog('warn', 'Unknown reload', { what: message.what });
          return;
        }
        await reload(message);
        return;
      }
      case 'db-release':
        releaseDb();
        send({ type: 'db-released', id: message.id }, { always: true });
        return;
      case 'drain':
        send(
          {
            type: 'drain-result',
            id: message.id,
            metrics: metricsToWire(Server.drainMetrics()),
            forwarder: Forwarder.getAndResetForwarderMetrics(),
          },
          { always: true },
        );
        return;
      case 'apply-forwarder':
        Forwarder.applyEncryptedForwarder();
        send({ ...statusMessage(), type: 'applied', id: message.id }, { always: true });
        return;
      case 'shutdown':
        proxyLog('info', 'The web app asked the proxy to exit');
        onShutdown();
        return;
      default:
        proxyLog('warn', 'Unknown message', { type: message.type });
    }
  }

  /** Serve from `saved` (the config the web app last wrote) and read everything. */
  async function start(saved) {
    if (saved) applyConfig(saved);
    else proxyLog('info', 'No saved config yet; the proxy serves once the web app sends one');
    Forwarder.applyEncryptedForwarder();
    await Server.reloadAll();
    Server.startOverridesRefresh();
  }

  function stop() {
    Server.stopServing();
    Forwarder.stopEncryptedForwarder();
    Db.closeProxyDb();
  }

  return { handle, statusMessage, releaseDb, checkDbFile, start, stop };
}
