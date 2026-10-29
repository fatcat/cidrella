/**
 * The web app's end of the socket to the DNS proxy process
 * (dns-proxy/main.js, protocol.js). It connects and keeps reconnecting, and
 * on every connect sends hello, the config and "read everything again", so a
 * proxy that outlived the web app, or one that restarted, catches up. It
 * keeps the last status the proxy sent, for the synchronous reads (proxy and
 * forwarder status), and hands the proxy's reports to the sinks.
 *
 * The config is also written to DATA_DIR/runtime, owner-only, so a proxy
 * that starts before the web app serves from it.
 *
 * With no supervisor (development: CIDRELLA_DNS_PROXY_SUPERVISOR unset), the
 * client starts the proxy itself as a child and stops it at exit.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { proxyRuntimePaths, socketPathTooLong, DATA_DIR } from '../dns-proxy/constants.js';
import { PROXY_ENTRY } from '../dns-proxy/code-id.js';
import { PROTOCOL_VERSION, encode, createDecoder, metricsFromWire } from '../dns-proxy/protocol.js';
import { atomicWrite } from './atomic-write.js';
import { proxyLog } from '../dns-proxy/log.js';

const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2000;
const REQUEST_TIMEOUT_MS = 3000;

let paths = proxyRuntimePaths();
let socket = null;
let connected = false;
let running = false;
let backoff = BACKOFF_FIRST_MS;
let retryTimer = null;
let config = null;
let codeId = null;
let status = null;
let statusAt = 0;
let peer = null;
let handlers = {};
let child = null;
let nextId = 1;
const waiting = new Map();

function write(message) {
  if (!connected) return false;
  socket.write(encode(message));
  return true;
}

function settle(id, value) {
  const entry = waiting.get(id);
  if (!entry) return;
  waiting.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(value);
}

function onMessage(message) {
  switch (message.type) {
    case 'hello':
      peer = { v: message.v, codeId: message.codeId, pid: message.pid };
      if (message.v !== PROTOCOL_VERSION) {
        proxyLog('warn', 'The DNS proxy speaks another protocol version, asking it to restart', {
          proxy: message.v,
          web: PROTOCOL_VERSION,
        });
        write({ type: 'shutdown' });
      }
      handlers.onHello?.(peer);
      return;
    case 'status':
      status = message;
      statusAt = Date.now();
      return;
    case 'applied':
      status = { ...message, type: 'status' };
      statusAt = Date.now();
      settle(message.id, status);
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

function spawnChild() {
  if (child || process.env.CIDRELLA_DNS_PROXY_SUPERVISOR) return;
  proxyLog('info', 'Starting the DNS proxy process (no supervisor)');
  child = spawn(process.execPath, [PROXY_ENTRY], {
    // The child goes when this process does, however it ends.
    env: { ...process.env, DATA_DIR, CIDRELLA_DNS_PROXY_PARENT: String(process.pid) },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    proxyLog('warn', 'The DNS proxy process exited', { code, signal });
    child = null;
  });
}

function scheduleConnect() {
  if (!running || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoff);
  retryTimer.unref?.();
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
}

function connect() {
  if (!running || socket) return;
  const sock = net.connect(paths.socket);
  socket = sock;
  sock.on('connect', () => {
    connected = true;
    backoff = BACKOFF_FIRST_MS;
    write({ type: 'hello', v: PROTOCOL_VERSION, codeId });
    if (config) write({ type: 'config', config });
    write({ type: 'reload', what: 'all' });
  });
  sock.on(
    'data',
    createDecoder(onMessage, (err) => {
      proxyLog('warn', 'Closing the DNS proxy connection', { error: err.message });
      sock.destroy();
    }),
  );
  sock.on('error', (err) => {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') spawnChild();
  });
  sock.on('close', () => {
    if (socket !== sock) return;
    socket = null;
    connected = false;
    peer = null;
    for (const id of [...waiting.keys()]) settle(id, null);
    scheduleConnect();
  });
}

/**
 * Start talking to the proxy. `handlers` are the sinks for its reports
 * (queryRow, clientSeen, resolution) and onHello(peer).
 */
export function startProxyClient({ codeId: id, handlers: sinks = {}, dataDir } = {}) {
  if (dataDir) paths = proxyRuntimePaths(dataDir);
  codeId = id ?? null;
  handlers = sinks;
  if (running) return;
  const tooLong = socketPathTooLong(paths.socket);
  if (tooLong) {
    proxyLog('error', tooLong);
    return;
  }
  running = true;
  connect();
}

export function stopProxyClient({ stopChild = true } = {}) {
  running = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  socket?.destroy();
  socket = null;
  connected = false;
  if (stopChild && child) {
    child.kill('SIGTERM');
    child = null;
  }
}

/** Give the proxy its config: written for its next start, and sent now. */
export function sendProxyConfig(next, { rebind = false } = {}) {
  config = next;
  try {
    fs.mkdirSync(path.dirname(paths.config), { recursive: true, mode: 0o700 });
    atomicWrite(paths.config, JSON.stringify(next), { mode: 0o600 });
  } catch (err) {
    proxyLog('error', 'Could not save the DNS proxy config', { error: err.message });
  }
  write({ type: 'config', config: next, rebind });
}

/** Have the proxy read something again (protocol.js RELOADS). */
export function sendReload(what, extra = {}) {
  write({ type: 'reload', what, ...extra });
}

function request(type) {
  if (!connected) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(id, null), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    waiting.set(id, { resolve, timer });
    write({ type, id });
  });
}

/** The proxy's counters since the last drain, or null when it does not answer. */
export const requestDrain = () => request('drain');

/** Restart the encrypted forwarder; resolves with the status after it, or null. */
export const requestApplyForwarder = () => request('apply-forwarder');

export function sendShutdown() {
  write({ type: 'shutdown' });
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

export const proxyConnected = () => connected;
export const proxyPeer = () => peer;

// The child must not outlive the web app in development. A web app that is
// killed outright fires no exit event; the child watches for that itself
// (CIDRELLA_DNS_PROXY_PARENT in dns-proxy/main.js).
process.on('exit', () => child?.kill('SIGTERM'));
