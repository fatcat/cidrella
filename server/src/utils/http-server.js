import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import { getSetting } from '../db/init.js';

// Port fallback order (v0.4.15+):
//   1. DB setting `https_port` / `http_port`  , source of truth when the
//      admin has saved a value via the UI (routes/interfaces.js).
//   2. process.env.HTTPS_PORT / HTTP_PORT     , systemd drop-in override
//      from install.sh, or a dev-mode override.
//   3. Hardcoded fallback (8443 / 8080)       , last resort.
//
// Every read goes through these helpers so a live port change immediately
// takes effect for subsequent reads.

const FALLBACK_HTTPS_PORT = 8443;
const FALLBACK_HTTP_PORT  = 8080;

function resolvePort(settingKey, envKey, fallback) {
  try {
    const fromDb = getSetting(settingKey);
    if (fromDb !== null && fromDb !== undefined && fromDb !== '') {
      const n = parseInt(fromDb, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
  } catch { /* DB may not be up yet; fall through */ }
  const fromEnv = process.env[envKey];
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return fallback;
}

export function getHttpsPort() { return resolvePort('https_port', 'HTTPS_PORT', FALLBACK_HTTPS_PORT); }
export function getHttpPort()  { return resolvePort('http_port',  'HTTP_PORT',  FALLBACK_HTTP_PORT);  }

function httpRedirectEnabled() {
  try {
    const raw = getSetting('http_redirect_enabled');
    return raw !== 'false';
  } catch { return true; }
}

// ─── Module-level state ─────────────────────────────────────────────────────
// Held so live-swap can close the old listener when we swap to a new port.
// Populated by startHttpsServer() at boot.
let _app = null;
let _tlsKeyPath = null;
let _tlsCertPath = null;
let _httpsServer = null;
let _httpsServerSetter = null;   // delegate for cert.js TLS reload
let _httpsPort = 0;
let _httpServer = null;
let _httpPort = 0;

// ─── Port-probe preflight ───────────────────────────────────────────────────
// Refuses a port change before we close the working listener. Binds to the
// requested port on 0.0.0.0, releases immediately, returns null on success
// or an error string on failure (EADDRINUSE, EACCES, etc.).
export async function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      resolve(`${err.code || err.name}: ${err.message}`);
    });
    tester.once('listening', () => {
      tester.close(() => resolve(null));
    });
    try {
      tester.listen(port, '0.0.0.0');
    } catch (err) {
      resolve(err.message);
    }
  });
}

// ─── HTTPS listener ─────────────────────────────────────────────────────────

function loadTlsOptions() {
  return {
    key: fs.readFileSync(_tlsKeyPath),
    cert: fs.readFileSync(_tlsCertPath)
  };
}

/**
 * Called once from main() at boot. Owns the initial listen. Subsequent port
 * changes via applyHttpsPortChange() close + relisten on a NEW server.
 */
export async function startHttpsServer({ app, keyPath, certPath, onReady, setHttpsServer }) {
  _app = app;
  _tlsKeyPath = keyPath;
  _tlsCertPath = certPath;
  _httpsServerSetter = setHttpsServer;

  const port = getHttpsPort();
  const server = https.createServer(loadTlsOptions(), app);
  _httpsServer = server;
  _httpsPort = port;
  if (_httpsServerSetter) _httpsServerSetter(server);
  server.listen(port, () => {
    console.log(`HTTPS server listening on port ${port}`);
    if (onReady) onReady();
  });
}

/**
 * Live-swap the HTTPS listener onto a new port. Creates a fresh server on
 * the target port, then closes the old one (in-flight requests finish
 * naturally). Preflight-bind fails cleanly without disturbing the old
 * listener, so if the new port is bad, the server stays reachable on the
 * old port.
 */
export async function applyHttpsPortChange(newPort) {
  if (!_httpsServer) throw new Error('HTTPS server not started yet');
  if (newPort === _httpsPort) return { changed: false };

  const probeErr = await checkPortAvailable(newPort);
  if (probeErr) throw new Error(`Port ${newPort} not bindable: ${probeErr}`);

  const newServer = https.createServer(loadTlsOptions(), _app);
  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    newServer.once('error', onErr);
    newServer.listen(newPort, () => {
      newServer.off('error', onErr);
      resolve();
    });
  });

  const oldServer = _httpsServer;
  const oldPort = _httpsPort;
  _httpsServer = newServer;
  _httpsPort = newPort;
  if (_httpsServerSetter) _httpsServerSetter(newServer);
  // close() stops accepting new connections; existing keep-alive sockets
  // on the old port will serve until idle-timeout.
  oldServer.close(() => console.log(`HTTPS moved from ${oldPort} to ${newPort}`));
  // The HTTP redirect server reads _httpsPort at request time (see
  // makeHttpRedirectServer), so no cycle is needed, its Location target
  // picks up the new port automatically.
  return { changed: true, oldPort, newPort };
}

// ─── HTTP redirect listener ─────────────────────────────────────────────────

function makeHttpRedirectServer() {
  const server = http.createServer((req, res) => {
    // Read the current HTTPS port AT REQUEST TIME, not capture it at server
    // creation. That way an HTTPS port change via applyHttpsPortChange()
    // automatically updates the Location target without needing to cycle
    // the redirect listener, avoids an EADDRINUSE race when we'd otherwise
    // try to rebind on the same port while the old socket is still in
    // TIME_WAIT.
    const httpsPort = _httpsPort;
    const reqHost = (req.headers.host || '').replace(/:\d+$/, '') || 'localhost';
    const hostWithPort = httpsPort === 443 ? reqHost : `${reqHost}:${httpsPort}`;
    res.writeHead(301, { Location: `https://${hostWithPort}${req.url}` });
    res.end();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`HTTP redirect port ${_httpPort} already in use, skipping HTTP redirect server`);
    } else {
      console.error('HTTP server error:', err);
    }
    _httpServer = null;
  });
  return server;
}

/**
 * Start or stop the HTTP redirect listener to match the enabled setting and
 * current http_port. Called at boot, whenever the UI toggles the enabled
 * flag, and whenever the HTTPS port changes (to refresh the Location target
 * inside the redirect handler closure).
 */
export async function applyHttpRedirectConfig() {
  const shouldRun = httpRedirectEnabled();
  const desiredPort = getHttpPort();

  if (!shouldRun && _httpServer) {
    const s = _httpServer;
    _httpServer = null;
    _httpPort = 0;
    s.close(() => console.log('HTTP redirect server stopped'));
    return;
  }
  if (shouldRun && !_httpServer) {
    const server = makeHttpRedirectServer();
    await new Promise((resolve) => {
      server.listen(desiredPort, () => {
        console.log(`HTTP redirect server listening on port ${desiredPort} -> ${_httpsPort}`);
        resolve();
      });
    });
    _httpServer = server;
    _httpPort = desiredPort;
    return;
  }
  if (shouldRun && _httpServer && desiredPort !== _httpPort) {
    // Port changed, restart the listener.
    await applyHttpPortChange(desiredPort, { force: true });
  }
}

/**
 * Live-swap the HTTP redirect listener onto a new port. `force:true` cycles
 * the listener unconditionally even when the port doesn't change, used
 * after an HTTPS port change so the redirect's Location-header target
 * closure sees the new httpsPort value.
 */
export async function applyHttpPortChange(newPort, { force = false } = {}) {
  if (!_httpServer) return { changed: false, reason: 'redirect not running' };
  if (newPort === _httpPort && !force) return { changed: false };

  if (newPort !== _httpPort) {
    const probeErr = await checkPortAvailable(newPort);
    if (probeErr) throw new Error(`Port ${newPort} not bindable: ${probeErr}`);
  }

  const newServer = makeHttpRedirectServer();
  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    newServer.once('error', onErr);
    newServer.listen(newPort, () => {
      newServer.off('error', onErr);
      resolve();
    });
  });

  const oldServer = _httpServer;
  const oldPort = _httpPort;
  _httpServer = newServer;
  _httpPort = newPort;
  oldServer.close(() => console.log(`HTTP redirect moved from ${oldPort} to ${newPort}`));
  return { changed: true, oldPort, newPort };
}

/** Current port binding + redirect state, for the Interfaces UI panel. */
export function getWebPortInfo() {
  return {
    https_port: _httpsPort || getHttpsPort(),
    http_port:  _httpPort  || getHttpPort(),
    http_redirect_enabled: httpRedirectEnabled(),
    http_listener_active:  _httpServer !== null
  };
}

// Backwards-compat re-exports so existing imports keep working. These are
// const snapshots of the values at MODULE LOAD, anything that needs the
// live value should call getHttpsPort() / getHttpPort() instead.
export const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
export const HTTP_PORT  = parseInt(process.env.HTTP_PORT  || '8080', 10);
