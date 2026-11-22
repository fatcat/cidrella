/**
 * The pinned sync client against the real HTTPS server: startHttpsServer and
 * applyHttpsPortChange from utils/http-server.js, serving a web certificate
 * and the sync identity side by side.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import zlib from 'zlib';
import { freePort } from '../helpers/free-port.js';

// The port ladder reads settings first; with none it falls to HTTPS_PORT.
vi.mock('../../src/db/init.js', () => ({ getSetting: () => null }));

const { startHttpsServer, applyHttpsPortChange } = await import('../../src/utils/http-server.js');
const { ensureCerts, setHttpsServer, generateSelfSignedCert, reloadTlsCerts } =
  await import('../../src/utils/cert.js');
const { SYNC_SERVER_NAME, ensureSyncIdentity, fingerprintOfCert, syncSecureContext } =
  await import('../../src/sync/identity.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');

let dataDir;
let identity;
let webCertPath;
let port;
let server; // the live https.Server, followed across a port change
const seen = []; // every request the handler got
const savedPort = process.env.HTTPS_PORT;

// What the app does with a request. Tests swap it.
let handler;
const echo = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
};
const app = (req, res) => {
  seen.push(`${req.method} ${req.url}`);
  handler(req, res);
};

/** The fingerprint of the certificate the server shows a client asking for `servername`. */
function presentedFingerprint(servername, atPort = port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port: atPort, servername, rejectUnauthorized: false },
      () => {
        const fp = fingerprintOfCert(socket.getPeerCertificate().raw);
        socket.destroy();
        resolve(fp);
      },
    );
    socket.once('error', reject);
  });
}

const webFingerprint = () => fingerprintOfCert(fs.readFileSync(webCertPath));

/** Can this machine listen on ::1? */
function ipv6Loopback() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

const call = (extra = {}) =>
  syncRequest({
    address: '127.0.0.1',
    port,
    fingerprint: identity.fingerprint,
    path: '/api/sync/ping',
    timeoutMs: 5000,
    ...extra,
  });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-sync-client-'));
  const web = ensureCerts(dataDir);
  webCertPath = web.certPath;
  identity = ensureSyncIdentity(dataDir);

  port = await freePort({ tcp: true });
  process.env.HTTPS_PORT = String(port);
  await new Promise((resolve) => {
    startHttpsServer({
      app,
      keyPath: web.keyPath,
      certPath: web.certPath,
      setHttpsServer: (s) => {
        server = s;
        setHttpsServer(s);
      },
      syncContext: () => syncSecureContext(dataDir),
      onReady: resolve,
    });
  });
});

afterAll(async () => {
  if (savedPort === undefined) delete process.env.HTTPS_PORT;
  else process.env.HTTPS_PORT = savedPort;
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  handler = echo;
});

describe('which certificate the HTTPS server presents', () => {
  it('serves the sync identity to a client asking for it by SNI', async () => {
    expect(await presentedFingerprint(SYNC_SERVER_NAME)).toBe(identity.fingerprint);
  });

  it('serves the web certificate to every other name, and to no name at all', async () => {
    expect(webFingerprint()).not.toBe(identity.fingerprint);
    expect(await presentedFingerprint('cidrella')).toBe(webFingerprint());
    expect(await presentedFingerprint('cidrella-sync.example.com')).toBe(webFingerprint());
    expect(await presentedFingerprint(undefined)).toBe(webFingerprint());
  });

  it('follows a replaced web certificate without disturbing the identity', async () => {
    const before = webFingerprint();
    generateSelfSignedCert();
    expect(reloadTlsCerts()).toBe(true);
    expect(webFingerprint()).not.toBe(before);
    expect(await presentedFingerprint('cidrella')).toBe(webFingerprint());
    expect(await presentedFingerprint(SYNC_SERVER_NAME)).toBe(identity.fingerprint);
  });
});

describe('syncRequest', () => {
  it('makes a request over IPv4 loopback', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.headers['content-type']).toContain('application/json');
    const echoed = JSON.parse(res.body);
    expect(echoed.method).toBe('GET');
    expect(echoed.url).toBe('/api/sync/ping');
    expect(echoed.headers.host).toBe(`127.0.0.1:${port}`);
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it('makes a request over IPv6 loopback', async (ctx) => {
    if (!(await ipv6Loopback())) return ctx.skip();
    // The server listens on the wildcard, which takes ::1 where IPv6 is up.
    const res = await call({ address: '::1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).headers.host).toBe(`[::1]:${port}`);
  });

  it('reaches a host by name', async () => {
    const res = await call({ address: 'localhost' });
    expect(res.status).toBe(200);
  });

  it('sends the credential as a bearer token and an object as JSON', async () => {
    const res = await call({
      method: 'POST',
      credential: 'secret-token',
      body: { since: 42 },
      headers: { 'X-Sync-Instance': 'abc' },
    });
    const echoed = JSON.parse(res.body);
    expect(echoed.method).toBe('POST');
    expect(echoed.headers.authorization).toBe('Bearer secret-token');
    expect(echoed.headers['content-type']).toBe('application/json');
    expect(echoed.headers['x-sync-instance']).toBe('abc');
    expect(JSON.parse(echoed.body)).toEqual({ since: 42 });
  });

  it('sends a Buffer as it is', async () => {
    const res = await call({
      method: 'PUT',
      body: Buffer.from([0x61, 0x62, 0x63]),
      headers: { 'content-type': 'application/octet-stream' },
    });
    const echoed = JSON.parse(res.body);
    expect(echoed.body).toBe('abc');
    expect(echoed.headers['content-type']).toBe('application/octet-stream');
    expect(echoed.headers['content-length']).toBe('3');
  });

  it('accepts a fingerprint in upper case', async () => {
    const res = await call({ fingerprint: identity.fingerprint.toUpperCase() });
    expect(res.status).toBe(200);
  });

  it('refuses a certificate that is not the pinned one, before sending anything', async () => {
    const wrong = 'ab'.repeat(32);
    const err = await call({ fingerprint: wrong, credential: 'secret-token' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('pin_mismatch');
    expect(err.message).toContain(`127.0.0.1:${port}`);
    expect(err.message).toContain('not the one expected');
    // Give a stray request time to land before saying none did.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toEqual([]);
  });

  it('refuses the web certificate too: only the identity is trusted', async () => {
    const err = await call({ fingerprint: webFingerprint() }).catch((e) => e);
    expect(err.code).toBe('pin_mismatch');
    expect(seen).toEqual([]);
  });

  it('rejects a fingerprint that is not a SHA-256 one without connecting', async () => {
    await expect(call({ fingerprint: 'abc123' })).rejects.toThrow(/64 hex characters/);
    await expect(call({ fingerprint: undefined })).rejects.toThrow(/64 hex characters/);
    expect(seen).toEqual([]);
  });

  it('decodes a gzip response', async () => {
    handler = (req, res) => {
      expect(req.headers['accept-encoding']).toBe('gzip');
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync('x'.repeat(5000)));
    };
    const res = await call();
    expect(res.body.toString()).toBe('x'.repeat(5000));
  });

  it('returns a redirect as it is, never following it', async () => {
    handler = (req, res) => {
      res.writeHead(302, { location: '/api/sync/elsewhere' });
      res.end();
    };
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/api/sync/elsewhere');
    expect(seen).toEqual(['GET /api/sync/ping']);
  });

  it('returns an error status rather than throwing', async () => {
    handler = (req, res) => {
      res.statusCode = 503;
      res.end('busy');
    };
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.toString()).toBe('busy');
  });

  it('times out on a server that never answers', async () => {
    handler = () => {};
    const started = Date.now();
    const err = await call({ timeoutMs: 300 }).catch((e) => e);
    expect(err.code).toBe('timeout');
    expect(seen).toEqual(['GET /api/sync/ping']);
    expect(err.message).toContain(`127.0.0.1:${port}`);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('says unreachable when nothing listens there', async () => {
    const dead = await freePort({ tcp: true });
    const err = await call({ port: dead }).catch((e) => e);
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain(`127.0.0.1:${dead}`);
  });

  it('says unreachable for a name that does not resolve', async () => {
    const err = await call({ address: 'no-such-host.invalid' }).catch((e) => e);
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('no-such-host.invalid');
  });

  it('says unreachable when the connection drops mid-response', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.destroy(), 50);
    };
    const err = await call().catch((e) => e);
    expect(err.code).toBe('unreachable');
  });

  it('refuses a response over the cap, declared or streamed', async () => {
    handler = (req, res) => res.end('y'.repeat(2000));
    expect((await call({ maxBytes: 1000 }).catch((e) => e)).code).toBe('too_large');

    handler = (req, res) => {
      res.write('y'.repeat(600));
      setTimeout(() => res.end('y'.repeat(600)), 20);
    };
    expect((await call({ maxBytes: 1000 }).catch((e) => e)).code).toBe('too_large');
  });

  it('refuses a small gzip body that inflates past the cap', async () => {
    handler = (req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync(Buffer.alloc(200000)));
    };
    const err = await call({ maxBytes: 10000 }).catch((e) => e);
    expect(err.code).toBe('too_large');
  });

  it('says bad_response for gzip that does not decode', async () => {
    handler = (req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end('not gzip at all');
    };
    expect((await call().catch((e) => e)).code).toBe('bad_response');
  });
});

describe('after a port change', () => {
  it('the new server presents both certificates the same way', async () => {
    const moved = await freePort({ tcp: true });
    const result = await applyHttpsPortChange(moved);
    expect(result.changed).toBe(true);
    port = moved;

    expect(await presentedFingerprint(SYNC_SERVER_NAME)).toBe(identity.fingerprint);
    expect(await presentedFingerprint('cidrella')).toBe(webFingerprint());
    const res = await call();
    expect(res.status).toBe(200);
  });
});

describe('without a sync identity', () => {
  it('builds the server with no SNI callback, as before', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-sync-client-'));
    const key = path.join(plainDir, 'k.pem');
    const cert = path.join(plainDir, 'c.pem');
    fs.copyFileSync(path.join(dataDir, 'certs', 'server.key'), key);
    fs.copyFileSync(path.join(dataDir, 'certs', 'server.crt'), cert);
    const plainPort = await freePort({ tcp: true });
    process.env.HTTPS_PORT = String(plainPort);
    let plain;
    try {
      await new Promise((resolve) => {
        startHttpsServer({
          app,
          keyPath: key,
          certPath: cert,
          setHttpsServer: (s) => (plain = s),
          onReady: resolve,
        });
      });
      expect(await presentedFingerprint(SYNC_SERVER_NAME, plainPort)).toBe(
        fingerprintOfCert(fs.readFileSync(cert)),
      );
    } finally {
      plain?.closeAllConnections();
      await new Promise((resolve) => (plain ? plain.close(resolve) : resolve()));
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
