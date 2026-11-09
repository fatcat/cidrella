/**
 * The DNS proxy as a process of its own (dns-proxy/main.js), driven through
 * the web app's client (utils/dns-proxy-client.js). It starts from the saved
 * config, answers over IPv4 and IPv6, keeps answering with the web app gone,
 * and hands over what it held once the web app is back.
 *
 * Real sockets on 127.0.0.1 and ::1; a stub stands in for the DNS backend on
 * the internal port.
 */
import fs from 'fs';
import dgram from 'dgram';
import path from 'path';
import { spawn } from 'child_process';
import dnsPacket from 'dns-packet';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CODE_GONE_EXIT } from '../../src/ipc/code-gone.js';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';
import { freePort } from '../helpers/free-port.js';

process.env.CIDRELLA_DNS_PROXY_SUPERVISOR = 'test';
const { proxyRuntimePaths } = await import('../../src/dns-proxy/constants.js');
const { PROXY_ENTRY } = await import('../../src/dns-proxy/code-id.js');
const Client = await import('../../src/utils/dns-proxy-client.js');

const waitFor = async (check, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
};

// The DNS backend: answers every A query with 192.0.2.1.
function startBackend(port) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const query = dnsPacket.decode(msg);
    const answer = dnsPacket.encode({
      id: query.id,
      type: 'response',
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: query.questions,
      answers: [{ type: 'A', name: query.questions[0].name, ttl: 60, data: '192.0.2.1' }],
    });
    sock.send(answer, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(port, '127.0.0.1', () => resolve(sock)));
}

function ask(address, port, name) {
  const sock = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
  const id = Math.floor(Math.random() * 65535);
  const query = dnsPacket.encode({
    id,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`no answer from ${address}`));
    }, 3000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(dnsPacket.decode(msg));
    });
    sock.send(query, port, address);
  });
}

let tmpDir;
let proxy;
let backend;
let listenPort;
const rows = [];
const clients = new Set();

const startClient = () =>
  Client.startProxyClient({
    dataDir: tmpDir,
    handlers: {
      queryRow: (row) => rows.push(row),
      clientSeen: (ip) => clients.add(ip),
      resolution: () => {},
    },
  });

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  listenPort = await freePort();
  const internalPort = await freePort();
  backend = await startBackend(internalPort);
  const { config, dir } = proxyRuntimePaths(tmpDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    config,
    JSON.stringify({
      proxy: {
        listenAddresses: ['127.0.0.1', '::1'],
        listenPort,
        internalPort,
        forwardsUnknownItself: true,
        queryLogPath: null,
        dnsOff: false,
        geoipDbPath: path.join(tmpDir, 'none.mmdb'),
      },
      defaults: {},
      serve: true,
    }),
  );
  proxy = spawn(process.execPath, [PROXY_ENTRY], {
    env: { ...process.env, DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  startClient();
  await waitFor(() => Client.freshProxyStatus()?.server.bound >= 2);
}, 15000);

afterAll(async () => {
  Client.stopProxyClient();
  proxy?.kill('SIGTERM');
  backend?.close();
  cleanupTestDb(tmpDir);
});

describe('the DNS proxy process', () => {
  it('serves from the saved config, either family', async () => {
    const v4 = await ask('127.0.0.1', listenPort, 'one.example');
    const v6 = await ask('::1', listenPort, 'two.example');
    expect(v4.answers[0].data).toBe('192.0.2.1');
    expect(v6.answers[0].data).toBe('192.0.2.1');
    await waitFor(() => rows.length >= 2);
    expect(rows.map((row) => row.domain)).toEqual(
      expect.arrayContaining(['one.example', 'two.example']),
    );
    expect(rows[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    await waitFor(() => clients.has('127.0.0.1') && clients.has('::1'));
  });

  it('keeps answering with the web app gone, and hands over what it held', async () => {
    Client.stopProxyClient();
    const answer = await ask('127.0.0.1', listenPort, 'while-away.example');
    expect(answer.answers[0].data).toBe('192.0.2.1');
    startClient();
    await waitFor(() => rows.some((row) => row.domain === 'while-away.example'));
  });

  it('answers a drain with what it counted', async () => {
    await waitFor(() => Client.proxyConnected());
    const drained = await Client.requestDrain();
    expect(drained.metrics.performance.queryCount).toBeGreaterThanOrEqual(3);
    expect(drained.metrics.countryHits).toBeInstanceOf(Map);
    expect(Array.isArray(drained.forwarder)).toBe(true);
  });

  it('lets go of the database for a restore, and opens the restored one after hello', async () => {
    const dbFile = path.join(tmpDir, 'cidrella.db');
    await waitFor(() => Client.freshProxyStatus()?.dbOpen);
    expect(await Client.requestDbRelease()).toBe(true);
    await waitFor(() => Client.freshProxyStatus()?.dbOpen === false);

    // The swap: a new file renamed over the old, as a restore does.
    const staged = `${dbFile}.staged`;
    fs.copyFileSync(dbFile, staged);
    fs.renameSync(staged, dbFile);
    // Still closed: the restore is not done until the web app is back.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(Client.freshProxyStatus().dbOpen).toBe(false);

    // The restored web app connects and says hello.
    Client.stopProxyClient();
    startClient();
    await waitFor(() => Client.freshProxyStatus()?.dbOpen, 10000);
  }, 20000);

  it('opens the database again when the file is replaced under it', async () => {
    const dbFile = path.join(tmpDir, 'cidrella.db');
    const before = await waitFor(() => Client.freshProxyStatus()?.dbIdentity);
    const staged = `${dbFile}.staged`;
    fs.copyFileSync(dbFile, staged);
    fs.renameSync(staged, dbFile);
    await waitFor(() => {
      const now = Client.freshProxyStatus()?.dbIdentity;
      return now && now !== before;
    }, 15000);
  }, 20000);

  it('created its socket and saved config owner-only', () => {
    const { socket } = proxyRuntimePaths(tmpDir);
    expect(fs.statSync(socket).mode & 0o077).toBe(0);
  });
});

const exited = (child) =>
  new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

// Each test using it starts its own proxy, so it can end it.
async function startProxy(entry, dir = fs.mkdtempSync(path.join(tmpDir, 'own-'))) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DATA_DIR: dir },
    stdio: 'ignore',
  });
  await waitFor(() => fs.existsSync(proxyRuntimePaths(dir).socket));
  return { child, dir };
}

describe('when the proxy exits by itself', () => {
  it('restarts once for a web app that ships other code, and not again', async () => {
    Client.stopProxyClient();
    const { child, dir } = await startProxy(PROXY_ENTRY);
    const done = exited(child);
    Client.startProxyClient({ dataDir: dir, codeId: 'other-code', handlers: {} });
    expect(await done).toEqual({ code: 0, signal: null });

    // Its supervisor starts the same code again: still other than the web
    // app's, but asked once already, so it keeps running.
    const again = await startProxy(PROXY_ENTRY, dir);
    await waitFor(() => Client.proxyPeer()?.pid === again.child.pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(again.child.exitCode).toBeNull();
    Client.stopProxyClient();
    again.child.kill('SIGTERM');
    await exited(again.child);
  }, 20000);

  it('exits when the file it was started from is gone', async () => {
    const link = path.join(tmpDir, 'main-link.js');
    fs.symlinkSync(PROXY_ENTRY, link);
    const { child } = await startProxy(link);
    const done = exited(child);
    fs.unlinkSync(link);
    expect(await done).toEqual({ code: CODE_GONE_EXIT, signal: null });
  }, 15000);
});

describe('the forwarder of a proxy that started first', () => {
  it('starts once the web app has made the database, and follows a change', async () => {
    Client.stopProxyClient();
    const { child, dir } = await startProxy(PROXY_ENTRY);
    const connect = () => Client.startProxyClient({ dataDir: dir, handlers: {} });
    const forwarderRunning = () => Client.freshProxyStatus()?.forwarder.running;

    // A first boot: no database and no saved config, so nothing to forward to.
    connect();
    await waitFor(() => Client.freshProxyStatus());
    expect(forwarderRunning()).toBe(false);

    // The web app restarts with the database made, and sends what it defaults to.
    Client.stopProxyClient();
    const dbFile = path.join(dir, 'cidrella.db');
    const { getDb } = await import('../../src/db/init.js');
    getDb().prepare('VACUUM INTO ?').run(dbFile);
    connect();
    Client.sendProxyConfig({
      proxy: {},
      defaults: { dns_upstream_servers: ['192.0.2.53', '2001:db8::53'] },
      serve: false,
    });
    await waitFor(forwarderRunning, 10000);

    // A setting changed while the web app was away, as a restore does.
    Client.stopProxyClient();
    const db = new Database(dbFile);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('dns_no_recursion', 'true') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();
    db.close();
    connect();
    await waitFor(() => forwarderRunning() === false, 10000);

    Client.stopProxyClient();
    child.kill('SIGTERM');
    await exited(child);
  }, 30000);
});
