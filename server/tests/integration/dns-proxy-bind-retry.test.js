/**
 * The proxy binds port 53 on each LAN address. An address not usable yet (an
 * IPv6 address waiting out Duplicate Address Detection after boot) fails with
 * EADDRNOTAVAIL; the proxy drops that socket and binds again shortly, UDP and
 * TCP, instead of staying deaf on it until a restart. Any other bind error
 * stays final, and stopping the proxy cancels a pending retry.
 *
 * Real sockets on 127.0.0.1 and ::1; the wrapped dgram and net modules fail
 * the binds a test asks them to.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const failures = { udp: new Map(), tcp: new Map() };
const bindCalls = [];
const queueFailure = (kind, addr, code) => {
  const list = failures[kind].get(addr) || [];
  list.push(code);
  failures[kind].set(addr, list);
};
const takeFailure = (kind, addr) => failures[kind].get(addr)?.shift();
const bindError = (code, addr, port) =>
  Object.assign(new Error(`bind ${code} ${addr}:${port}`), { code });

vi.mock('dgram', async (importOriginal) => {
  const real = await importOriginal();
  const createSocket = (...args) => {
    const sock = real.createSocket(...args);
    const bind = sock.bind.bind(sock);
    sock.bind = (port, addr, cb) => {
      if (typeof addr !== 'string') return bind(port, addr, cb);
      bindCalls.push(['udp', addr]);
      const code = takeFailure('udp', addr);
      if (!code) return bind(port, addr, cb);
      setImmediate(() => sock.emit('error', bindError(code, addr, port)));
      return sock;
    };
    return sock;
  };
  return { ...real, createSocket, default: { ...real.default, createSocket } };
});

vi.mock('net', async (importOriginal) => {
  const real = await importOriginal();
  const createServer = (...args) => {
    const server = real.createServer(...args);
    const listen = server.listen.bind(server);
    server.listen = (port, addr, cb) => {
      if (typeof addr !== 'string') return listen(port, addr, cb);
      bindCalls.push(['tcp', addr]);
      const code = takeFailure('tcp', addr);
      if (!code) return listen(port, addr, cb);
      setImmediate(() => server.emit('error', bindError(code, addr, port)));
      return server;
    };
    return server;
  };
  return { ...real, createServer, default: { ...real.default, createServer } };
});

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const os = (await import('os')).default;
const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { startProxy, stopProxy, getProxyStatus } = await import('../../src/utils/dns-proxy.js');

const PORT = 20000 + Math.floor(Math.random() * 20000);
let tmpDir;
beforeAll(async () => {
  let db;
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dns_listen_port', ?)").run(
    String(PORT),
  );
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('interface_config', ?)").run(
    JSON.stringify({ eth0: { dns: true, dhcp: false } }),
  );
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      { family: 'IPv4', address: '127.0.0.1', internal: false },
      { family: 'IPv6', address: '::1', internal: false },
    ],
  });
});
afterEach(() => {
  stopProxy();
  failures.udp.clear();
  failures.tcp.clear();
  bindCalls.length = 0;
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

const listening = () => [...getProxyStatus().listenAddresses].sort();
const calls = (kind, addr) => bindCalls.filter(([k, a]) => k === kind && a === addr).length;

describe('proxy bind retry', () => {
  it('binds an IPv6 address again once it becomes usable, UDP and TCP', async () => {
    queueFailure('udp', '::1', 'EADDRNOTAVAIL');
    queueFailure('tcp', '::1', 'EADDRNOTAVAIL');
    startProxy();
    await vi.waitFor(() => expect(listening()).toEqual(['127.0.0.1']));
    expect(getProxyStatus().running).toBe(true);
    await vi.waitFor(() => expect(listening()).toEqual(['127.0.0.1', '::1']), { timeout: 3000 });
    expect(calls('udp', '::1')).toBe(2);
    await vi.waitFor(() => expect(calls('tcp', '::1')).toBe(2), { timeout: 3000 });
    expect(getProxyStatus().tcpListeners).toBe(2);
  });

  it('does the same for an IPv4 address', async () => {
    queueFailure('udp', '127.0.0.1', 'EADDRNOTAVAIL');
    startProxy();
    await vi.waitFor(() => expect(listening()).toEqual(['::1']));
    await vi.waitFor(() => expect(listening()).toEqual(['127.0.0.1', '::1']), { timeout: 3000 });
  });

  it('leaves any other bind error final and the address unlisted', async () => {
    queueFailure('udp', '::1', 'EADDRINUSE');
    startProxy();
    await vi.waitFor(() => expect(listening()).toEqual(['127.0.0.1']));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(calls('udp', '::1')).toBe(1);
    expect(listening()).toEqual(['127.0.0.1']);
  });

  it('cancels a pending retry when the proxy stops', async () => {
    queueFailure('udp', '::1', 'EADDRNOTAVAIL');
    startProxy();
    await vi.waitFor(() => expect(listening()).toEqual(['127.0.0.1']));
    stopProxy();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(calls('udp', '::1')).toBe(1);
    expect(getProxyStatus().running).toBe(false);
  });
});
