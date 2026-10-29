/**
 * Proxy bypass ends. Before, once the health monitor put the DNS backend on
 * the LAN port it stayed there: the monitor returned on `bypassMode` before
 * trying the proxy again, and the stored `dns_proxy_bypass` put the backend
 * back on the LAN port at every boot, so filtering, GeoIP and the query log
 * stayed off until someone deleted the setting by hand (REVIEW.md
 * PROXY-BYPASS-01).
 *
 * The sockets are faked: a bind to the LAN port (53) fails while `blocked`,
 * and a bind to any other port succeeds, as when something else holds 53.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
// The proxy under test runs in this process.
vi.mock('../../../src/utils/dns-proxy-client.js', async () =>
  (await import('../../helpers/proxy-in-process.js')).inProcessProxyClient(),
);
import os from 'os';
import { EventEmitter } from 'events';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

// `delayMs` makes applyListenNow take that long, as a real restart does;
// `lanBinds` records, for each bind to the LAN port, whether it was still
// running.
const calls = vi.hoisted(() => ({
  applyListen: 0,
  audits: [],
  delayMs: 0,
  restarting: false,
  lanBinds: [],
}));
vi.mock('../../../src/services/backend-apply.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyListenNow: () => {
    calls.applyListen++;
    if (!calls.delayMs) return Promise.resolve();
    calls.restarting = true;
    return new Promise((resolve) =>
      setTimeout(() => {
        calls.restarting = false;
        resolve();
      }, calls.delayMs),
    );
  },
}));
vi.mock('../../../src/services/audit.js', () => ({
  recordAudit: (row) => calls.audits.push(row),
}));

const port = vi.hoisted(() => ({ blocked: true }));
vi.mock('dgram', async () => {
  const { EventEmitter: Emitter } = await import('events');
  const createSocket = () => {
    const sock = new Emitter();
    sock.bind = (p, _addr, cb) => {
      if (p === 53) calls.lanBinds.push(calls.restarting);
      process.nextTick(() => {
        if (p === 53 && port.blocked) {
          sock.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        } else cb?.();
      });
    };
    sock.close = () => process.nextTick(() => sock.emit('close'));
    sock.send = () => {};
    return sock;
  };
  return { default: { createSocket }, createSocket };
});
vi.mock('net', async (importOriginal) => {
  const real = await importOriginal();
  const createServer = () => {
    const server = new EventEmitter();
    server.listen = () => {};
    server.close = () => {};
    return server;
  };
  return { ...real, default: { ...real.default, createServer }, createServer };
});

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const { getSetting, setSetting, getDb } = await import('../../../src/db/init.js');
const proxy = await import('../../../src/utils/dns-proxy.js');

const MIN = 60 * 1000;
const actions = () => calls.audits.map((a) => a.action);
let tmpDir;

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [{ family: 'IPv4', address: '10.9.9.9', netmask: '255.255.255.0', internal: false }],
  });
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  proxy.stopProxy();
  vi.useRealTimers();
});

// Start with port 53 held, and run the health monitor until bypass is on.
async function intoBypass() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  calls.applyListen = 0;
  calls.audits.length = 0;
  port.blocked = true;
  proxy.startProxy();
  // Three dead checks 3 s apart, then three restarts 5 s apart.
  await vi.advanceTimersByTimeAsync(40 * 1000);
  expect(proxy.isProxyBypassed()).toBe(true);
  expect(getSetting('dns_proxy_bypass')).toBe('true');
  expect(actions()).toEqual(['dns_proxy_bypass_activated']);
}

describe('proxy bypass', () => {
  it('ends once the proxy can bind its port again', async () => {
    await intoBypass();
    port.blocked = false;

    // Nothing happens before the first wait is up.
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(proxy.isProxyBypassed()).toBe(true);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(proxy.isProxyBypassed()).toBe(false);
    expect(getSetting('dns_proxy_bypass')).toBeNull();
    expect(proxy.getProxyStatus().running).toBe(true);
    expect(calls.audits.at(-1)).toMatchObject({
      action: 'dns_proxy_bypass_deactivated',
      source: 'proxy-health',
      details: { reason: 'the proxy bound its addresses again' },
    });
  });

  it('stays on while the port is still held, and waits longer before each try', async () => {
    await intoBypass();
    const afterEntry = calls.applyListen;

    // First try at 5 minutes: the backend leaves the LAN port and comes back.
    await vi.advanceTimersByTimeAsync(5 * MIN + 10 * 1000);
    expect(calls.applyListen).toBe(afterEntry + 2);
    expect(proxy.isProxyBypassed()).toBe(true);
    expect(getSetting('dns_proxy_bypass')).toBe('true');

    // The next try waits 10 minutes, not 5.
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(calls.applyListen).toBe(afterEntry + 2);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(calls.applyListen).toBe(afterEntry + 4);

    // A failed try is logged, not audited: only the transitions are rows.
    expect(actions()).toEqual(['dns_proxy_bypass_activated']);

    port.blocked = false;
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(proxy.isProxyBypassed()).toBe(false);
  });

  it('binds the LAN port only once the backend has left it', async () => {
    await intoBypass();
    port.blocked = false;
    calls.delayMs = 3000;
    calls.lanBinds.length = 0;
    try {
      // Up to the try: the backend is leaving the LAN port.
      for (let s = 0; s < 6 * 60 && !calls.restarting; s++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(calls.restarting).toBe(true);
      // Still restarting: the proxy has not tried the port.
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.restarting).toBe(true);
      expect(calls.lanBinds).toEqual([]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(proxy.isProxyBypassed()).toBe(false);
      expect(calls.lanBinds.length).toBeGreaterThan(0);
      expect(calls.lanBinds).not.toContain(true);
    } finally {
      calls.delayMs = 0;
    }
  });

  it('leaves the proxy alone on an interface rebind while bypassed', async () => {
    await intoBypass();
    const before = calls.applyListen;
    proxy.rebindProxy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(proxy.isProxyBypassed()).toBe(true);
    expect(calls.applyListen).toBe(before);

    // The health monitor kept running through the rebind: recovery still comes.
    port.blocked = false;
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(proxy.isProxyBypassed()).toBe(false);
  });
});

describe('clearBypassAtBoot', () => {
  it('forgets a stored bypass and records it, and does nothing without one', () => {
    calls.audits.length = 0;
    setSetting('dns_proxy_bypass', 'true');
    expect(proxy.clearBypassAtBoot(getDb())).toBe(true);
    expect(getSetting('dns_proxy_bypass')).toBeNull();
    expect(calls.audits).toEqual([
      expect.objectContaining({ action: 'dns_proxy_bypass_deactivated', source: 'boot' }),
    ]);

    expect(proxy.clearBypassAtBoot(getDb())).toBe(false);
    expect(calls.audits).toHaveLength(1);
  });
});
