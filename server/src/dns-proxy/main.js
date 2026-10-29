/**
 * The DNS proxy as a process of its own (cidrella-dns-proxy): the proxy
 * (server.js) and the encrypted forwarder (forwarder.js), so DNS keeps
 * answering while the web app restarts, updates or stalls.
 *
 * It starts from what the web app last told it (the config file in
 * DATA_DIR/runtime), so it serves before the web app is up, and reads the
 * database through its own read-only connection (db.js). The web app
 * connects to its socket (ipc-server.js, protocol.js) to change the config,
 * have it read something again, and take its counters and reports; while the
 * web app is away the reports wait in a bounded outbox.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, proxyRuntimePaths } from './constants.js';
import { codeId } from './code-id.js';
import { proxyLog } from './log.js';
import * as Db from './db.js';
import { PROTOCOL_VERSION, STATUS_INTERVAL_MS, metricsToWire } from './protocol.js';
import { createIpcServer, createOutbox, OUTBOX_BATCH } from './ipc-server.js';
import * as Server from './server.js';
import * as Forwarder from './forwarder.js';

const DB_FILE = path.join(DATA_DIR, 'cidrella.db');
const DB_RETRY_MS = 5000;
const DB_CHECK_MS = 5000;
// A release a restore asked for ends at the restored web app's hello, or
// after this, whichever comes first.
const DB_RELEASE_MAX_MS = 120_000;
const paths = proxyRuntimePaths();
const myCodeId = codeId();
const outbox = createOutbox();

// Which file a path is now: device and inode, or 'missing'.
function identity(file) {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return 'missing';
  }
}
const dbIdentity = () => [identity(DB_FILE), identity(`${DB_FILE}-shm`)].join(' ');

// The database, opened when it can be: the web app creates it, so a first
// boot may start the proxy before it exists. Closed while a restore swaps
// the files (`releasedUntil`).
let lastDbTry = 0;
let openedAs = null;
let releasedUntil = 0;
function database() {
  if (Date.now() < releasedUntil) return null;
  const open = Db.proxyDb();
  if (open) return open;
  const now = Date.now();
  if (now - lastDbTry < DB_RETRY_MS) return null;
  lastDbTry = now;
  try {
    const opened = Db.openProxyDb(DB_FILE);
    openedAs = dbIdentity();
    return opened;
  } catch (err) {
    proxyLog('warn', 'Could not open the database read-only', {
      file: DB_FILE,
      error: err.message,
    });
    return null;
  }
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

let flushQueued = false;
function flushSoon() {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    outbox.flush((message) => ipc.send(message));
  });
}

Server.configureProxyServer({
  ...settings,
  db: database,
  // Stamped now: a report can wait in the outbox for minutes.
  queryRow: (entry) => {
    outbox.row({ ...entry, ts: new Date().toISOString() });
    if (outbox.rowCount() >= OUTBOX_BATCH) flushSoon();
  },
  liveness: (clientIp) => outbox.client(clientIp),
  resolution: (event) => outbox.resolution({ ...event, at: Date.now() }),
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
  current = next;
  Db.setSettingDefaults(next.defaults || {});
  Server.setProxyConfig(next.proxy || {});
  if (!changed && !rebind) return;
  Server.stopServing();
  if (next.serve !== false) Server.startServing();
}

function readSavedConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return null;
  }
}

function statusMessage() {
  return {
    type: 'status',
    pid: process.pid,
    codeId: myCodeId,
    serve: current ? current.serve !== false : false,
    server: Server.serverStatus(),
    forwarder: Forwarder.getEncryptedForwarderStatus(),
    geoipLoaded: Server.isGeoipLoaded(),
    dbOpen: Db.proxyDb() !== null,
    // Which file it has open (device:inode of the database and its -shm).
    dbIdentity: Db.proxyDb() ? openedAs : null,
    dropped: outbox.dropped(),
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
      ipc.send(
        { type: 'hello', v: PROTOCOL_VERSION, codeId: myCodeId, pid: process.pid },
        { always: true },
      );
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
      releasedUntil = Date.now() + DB_RELEASE_MAX_MS;
      Db.closeProxyDb();
      proxyLog('info', 'Closed the database for a restore');
      ipc.send({ type: 'db-released', id: message.id }, { always: true });
      return;
    case 'drain':
      ipc.send(
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
      ipc.send({ ...statusMessage(), type: 'applied', id: message.id }, { always: true });
      return;
    case 'shutdown':
      proxyLog('info', 'The web app asked the proxy to exit');
      shutdown(0);
      return;
    default:
      proxyLog('warn', 'Unknown message', { type: message.type });
  }
}

const ipc = createIpcServer({
  socketPath: paths.socket,
  onMessage: (message) => {
    handle(message).catch((err) =>
      proxyLog('error', 'Handling a web app message failed', {
        type: message.type,
        error: err.message,
      }),
    );
  },
  onConnect: () => proxyLog('info', 'The web app connected'),
  onDisconnect: () => proxyLog('info', 'The web app disconnected; reports wait in the outbox'),
  log: proxyLog,
});

let statusTimer = null;
let flushTimer = null;
let dbCheckTimer = null;

// A database file replaced under the open connection (a restore, an
// operator's copy) would keep the proxy reading the old one: open the file
// now there instead.
function checkDbFile() {
  if (!Db.proxyDb() || dbIdentity() === openedAs) return;
  proxyLog('info', 'The database file changed, opening it again');
  Db.closeProxyDb();
  lastDbTry = 0;
  database();
}

function shutdown(code) {
  clearInterval(statusTimer);
  clearInterval(flushTimer);
  clearInterval(dbCheckTimer);
  Server.stopServing();
  Forwarder.stopEncryptedForwarder();
  ipc.close();
  Db.closeProxyDb();
  process.exit(code);
}

// The file the proxy was started from gone means the code it came from is
// gone: a rollback to a release without a separate proxy. It exits, and its
// unit's ConditionPathExists keeps it from being started again; the old web
// app runs the proxy itself.
const entry = process.argv[1];
setInterval(() => {
  if (!fs.existsSync(entry)) {
    proxyLog('info', 'The proxy code is gone (a rollback?), exiting', { entry });
    shutdown(0);
  }
}, 1000).unref();

// Started by the web app itself (development, no supervisor): exit when it
// is gone, however it ended.
const parentPid = Number(process.env.CIDRELLA_DNS_PROXY_PARENT) || null;
if (parentPid) {
  setInterval(() => {
    if (process.ppid !== parentPid) {
      proxyLog('info', 'The web app that started the proxy is gone, exiting');
      shutdown(0);
    }
  }, 1000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

const saved = readSavedConfig();
if (saved) applyConfig(saved);
else proxyLog('info', 'No saved config yet; the proxy serves once the web app sends one');
Forwarder.applyEncryptedForwarder();
await Server.reloadAll();
Server.startOverridesRefresh();
await ipc.listen();

statusTimer = setInterval(() => ipc.send(statusMessage(), { always: true }), STATUS_INTERVAL_MS);
flushTimer = setInterval(() => outbox.flush((message) => ipc.send(message)), 1000);
dbCheckTimer = setInterval(checkDbFile, DB_CHECK_MS);
proxyLog('info', 'DNS proxy process started', { pid: process.pid, codeId: myCodeId });
