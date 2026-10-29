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
import { STATUS_INTERVAL_MS } from './protocol.js';
import { createIpcServer, createOutbox, OUTBOX_BATCH } from './ipc-server.js';
import { createProxyRuntime } from './runtime.js';

const DB_CHECK_MS = 5000;
const paths = proxyRuntimePaths();
const outbox = createOutbox();
const myCodeId = codeId();

let flushQueued = false;
function flushSoon() {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    outbox.flush((message) => ipc.send(message));
  });
}

const runtime = createProxyRuntime({
  dbFile: path.join(DATA_DIR, 'cidrella.db'),
  codeId: myCodeId,
  send: (message, opts) => ipc.send(message, opts),
  // Stamped now: a report can wait in the outbox for minutes.
  reports: {
    queryRow: (entry) => {
      outbox.row({ ...entry, ts: new Date().toISOString() });
      if (outbox.rowCount() >= OUTBOX_BATCH) flushSoon();
    },
    liveness: (clientIp) => outbox.client(clientIp),
    resolution: (event) => outbox.resolution({ ...event, at: Date.now() }),
  },
  onShutdown: () => shutdown(0),
});

const statusMessage = () => ({ ...runtime.statusMessage(), dropped: outbox.dropped() });

function readSavedConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return null;
  }
}

const ipc = createIpcServer({
  socketPath: paths.socket,
  onMessage: (message) => {
    runtime.handle(message).catch((err) =>
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

function shutdown(code) {
  clearInterval(statusTimer);
  clearInterval(flushTimer);
  clearInterval(dbCheckTimer);
  runtime.stop();
  ipc.close();
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

// The shell's way to have it close the database (rollback.sh and update.sh copy a database
// snapshot back with the web app stopped): systemctl kill -s SIGUSR2.
process.on('SIGUSR2', runtime.releaseDb);
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

await runtime.start(readSavedConfig());
await ipc.listen();

statusTimer = setInterval(() => ipc.send(statusMessage(), { always: true }), STATUS_INTERVAL_MS);
flushTimer = setInterval(() => outbox.flush((message) => ipc.send(message)), 1000);
dbCheckTimer = setInterval(runtime.checkDbFile, DB_CHECK_MS);
proxyLog('info', 'DNS proxy process started', { pid: process.pid, codeId: myCodeId });
