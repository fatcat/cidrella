/**
 * The web app's end of the socket to the DNS proxy process
 * (dns-proxy/main.js, protocol.js), on the shared process client
 * (ipc/client.js). On every connect it sends the config and "read everything
 * again", so a proxy that outlived the web app, or one that restarted,
 * catches up. It keeps the last status the proxy sent, for the synchronous
 * reads (proxy and forwarder status), and hands the proxy's reports to the
 * sinks.
 *
 * The config is also written to DATA_DIR/runtime, owner-only, so a proxy
 * that starts before the web app serves from it.
 *
 * With no supervisor (development: CIDRELLA_DNS_PROXY_SUPERVISOR unset), the
 * client starts the proxy itself as a child and stops it at exit.
 */
import fs from 'fs';
import path from 'path';
import { proxyRuntimePaths, DATA_DIR } from '../dns-proxy/constants.js';
import { PROXY_ENTRY } from '../dns-proxy/code-id.js';
import { PROTOCOL_VERSION, metricsFromWire } from '../dns-proxy/protocol.js';
import { createProcessClient } from '../ipc/client.js';
import { atomicWrite } from './atomic-write.js';
import { proxyLog } from '../dns-proxy/log.js';

let paths = proxyRuntimePaths();
let config = null;
let status = null;
let statusAt = 0;
let handlers = {};

function onMessage(message, settle) {
  switch (message.type) {
    case 'status':
      status = message;
      statusAt = Date.now();
      return;
    case 'applied':
      status = { ...message, type: 'status' };
      statusAt = Date.now();
      settle(message.id, status);
      return;
    case 'db-released':
      settle(message.id, true);
      return;
    case 'drain-result':
      settle(message.id, {
        metrics: metricsFromWire(message.metrics),
        forwarder: message.forwarder,
      });
      return;
    case 'rows':
      for (const row of message.rows || []) handlers.queryRow?.(row);
      return;
    case 'liveness':
      for (const ip of message.clients || []) handlers.clientSeen?.(ip);
      return;
    case 'resolutions':
      for (const event of message.events || []) handlers.resolution?.(event);
      return;
    default:
      proxyLog('warn', 'Unknown message from the DNS proxy', { type: message.type });
  }
}

const client = createProcessClient({
  name: 'DNS proxy',
  protocolVersion: PROTOCOL_VERSION,
  entry: PROXY_ENTRY,
  supervisorEnv: 'CIDRELLA_DNS_PROXY_SUPERVISOR',
  parentEnv: 'CIDRELLA_DNS_PROXY_PARENT',
  childEnv: () => ({ DATA_DIR }),
  log: proxyLog,
  onMessage,
  onHello: (peer) => handlers.onHello?.(peer),
  onConnect(write) {
    if (config) write({ type: 'config', config });
    write({ type: 'reload', what: 'all' });
    // After the config, whose defaults it can read as: the proxy may have
    // started before there was a database, or the settings changed while this
    // process was down (a restore).
    write({ type: 'refresh-forwarder' });
  },
});

/**
 * Start talking to the proxy. `handlers` are the sinks for its reports
 * (queryRow, clientSeen, resolution) and onHello(peer).
 */
export function startProxyClient({ codeId, handlers: sinks = {}, dataDir } = {}) {
  if (dataDir) paths = proxyRuntimePaths(dataDir);
  handlers = sinks;
  client.start({ socketPath: paths.socket, codeId: codeId ?? null });
}

export const stopProxyClient = (options) => client.stop(options);

/** Give the proxy its config: written for its next start, and sent now. */
export function sendProxyConfig(next, { rebind = false } = {}) {
  config = next;
  try {
    fs.mkdirSync(path.dirname(paths.config), { recursive: true, mode: 0o700 });
    atomicWrite(paths.config, JSON.stringify(next), { mode: 0o600 });
  } catch (err) {
    proxyLog('error', 'Could not save the DNS proxy config', { error: err.message });
  }
  client.write({ type: 'config', config: next, rebind });
}

/** Have the proxy read something again (RELOADERS in dns-proxy/main.js). */
export function sendReload(what, extra = {}) {
  client.write({ type: 'reload', what, ...extra });
}

/** The proxy's counters since the last drain, or null when it does not answer. */
export const requestDrain = () => client.request('drain');

/** Restart the encrypted forwarder; resolves with the status after it, or null. */
export const requestApplyForwarder = () => client.request('apply-forwarder');

/**
 * Have the proxy close its database before a restore swaps the files, and
 * keep it closed until the restored web app says hello. Resolves true once
 * it has, null if it did not answer within 1 s.
 */
export const requestDbRelease = () => client.request('db-release', {}, 1000);

export function sendShutdown() {
  client.write({ type: 'shutdown' });
}

// A status older than this means the proxy process is not reporting.
const STATUS_STALE_MS = 3000;

/** The last status the proxy sent and when, or null before the first. */
export function lastProxyStatus() {
  return status ? { status, at: statusAt } : null;
}

/** The proxy's status if it reported in the last 3 s, else null. */
export function freshProxyStatus(now = Date.now()) {
  return status && now - statusAt < STATUS_STALE_MS ? status : null;
}

export const proxyConnected = () => client.connected();
export const proxyPeer = () => client.peer();
