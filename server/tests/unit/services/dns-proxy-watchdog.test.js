/**
 * The watchdog over a DNS proxy process (services/dns-proxy-watchdog.js),
 * driven through a fake handle: a proxy that stops reporting is restarted
 * only after three dead checks in a row; one that will not come back puts
 * the DNS backend on the LAN port with the forwarder down, keeps the proxy
 * off it, and is tried again later.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
const calls = vi.hoisted(() => ({ applyListen: [], audits: [], switching: false }));
vi.mock('../../../src/services/backend-apply.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyListenNow: async (db) => {
    const read = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    calls.applyListen.push({
      bypass: read('dns_proxy_bypass') ?? null,
      forwarderDown: read('dns_forwarder_down') ?? null,
    });
  },
}));
vi.mock('../../../src/services/audit.js', () => ({
  recordAudit: (row) => calls.audits.push(row),
}));
vi.mock('../../../src/utils/switch-state.js', () => ({ switchInProgress: () => calls.switching }));

const { getDb } = await import('../../../src/db/init.js');
const Watchdog = await import('../../../src/services/dns-proxy-watchdog.js');
const { PROXY_HEALTH_CHECK_MS, PROXY_RECOVERY_FIRST_MS } =
  await import('../../../src/config/defaults.js');

// A proxy process that reports while `up`, and serves unless `serve` is false.
function fakeProcess() {
  const proxy = {
    up: true,
    serve: true,
    bound: 1,
    restarts: 0,
    comesBack: false,
    events: [],
  };
  proxy.handle = {
    dead: () => !proxy.up || (proxy.serve && proxy.bound === 0),
    misses: 3,
    restart: () => {
      proxy.restarts++;
      if (proxy.comesBack) proxy.up = true;
    },
    settleMs: 100,
    anyBound: () => proxy.up && proxy.bound > 0,
    bind: () => {
      proxy.serve = true;
      proxy.events.push('bind');
    },
    release: () => {
      proxy.serve = false;
      proxy.events.push('release');
    },
    processDown: () => !proxy.up,
    listenAddresses: () => ['127.0.0.1', '::1'],
  };
  return proxy;
}

const setting = (key) =>
  getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const tick = (n = 1) => vi.advanceTimersByTimeAsync(PROXY_HEALTH_CHECK_MS * n);

let tmpDir;
beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'Date'] });
  calls.applyListen.length = 0;
  calls.audits.length = 0;
  calls.switching = false;
});
afterEach(async () => {
  Watchdog.stopWatchdog();
  // Let a restart or recovery still running finish before the next test.
  await vi.advanceTimersByTimeAsync(60_000);
  Watchdog.clearBypassAtBoot(getDb());
  vi.useRealTimers();
});

describe('the watchdog over a proxy process', () => {
  it('leaves a reporting proxy alone, and restarts one only after three silent checks', async () => {
    const proxy = fakeProcess();
    Watchdog.startWatchdog(proxy.handle);
    await tick(3);
    expect(proxy.restarts).toBe(0);
    proxy.up = false;
    proxy.comesBack = true;
    await tick(2);
    expect(proxy.restarts).toBe(0);
    await tick(1);
    expect(proxy.restarts).toBe(1);
    expect(Watchdog.isProxyBypassed()).toBe(false);
  });

  it('puts the backend on the LAN port with the forwarder down when the process stays gone', async () => {
    const proxy = fakeProcess();
    Watchdog.startWatchdog(proxy.handle);
    proxy.up = false;
    await tick(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proxy.restarts).toBe(3);
    expect(Watchdog.isProxyBypassed()).toBe(true);
    expect(proxy.events).toEqual(['release']);
    expect(calls.applyListen.at(-1)).toEqual({ bypass: 'true', forwarderDown: 'true' });
    expect(calls.audits.at(-1)).toMatchObject({
      action: 'dns_proxy_bypass_activated',
      details: { forwarderDown: true },
    });
  });

  it('keeps the forwarder when the process is up but binds nothing', async () => {
    const proxy = fakeProcess();
    Watchdog.startWatchdog(proxy.handle);
    proxy.bound = 0;
    await tick(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Watchdog.isProxyBypassed()).toBe(true);
    expect(calls.applyListen.at(-1)).toEqual({ bypass: 'true', forwarderDown: null });
  });

  it('brings a gone process back first, then leaves bypass once it binds', async () => {
    const proxy = fakeProcess();
    Watchdog.startWatchdog(proxy.handle);
    proxy.up = false;
    await tick(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Watchdog.isProxyBypassed()).toBe(true);

    // Still down at the first try: bypass stays, the forwarder still down.
    await vi.advanceTimersByTimeAsync(PROXY_RECOVERY_FIRST_MS);
    expect(Watchdog.isProxyBypassed()).toBe(true);
    expect(setting('dns_forwarder_down')).toBe('true');

    proxy.comesBack = true;
    await vi.advanceTimersByTimeAsync(PROXY_RECOVERY_FIRST_MS * 2 + PROXY_HEALTH_CHECK_MS);
    expect(Watchdog.isProxyBypassed()).toBe(false);
    expect(proxy.events).toEqual(['release', 'bind']);
    expect(setting('dns_proxy_bypass')).toBeNull();
    expect(setting('dns_forwarder_down')).toBeNull();
    expect(calls.audits.at(-1)).toMatchObject({ action: 'dns_proxy_bypass_deactivated' });
  });

  it('does not turn bypass on while a stack switch moves the backend', async () => {
    const proxy = fakeProcess();
    calls.switching = true;
    Watchdog.startWatchdog(proxy.handle);
    proxy.up = false;
    await tick(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Watchdog.isProxyBypassed()).toBe(false);
    expect(calls.applyListen).toEqual([]);
  });

  it('forgets the forwarder being down at boot, with the bypass', () => {
    getDb().prepare("INSERT OR REPLACE INTO settings VALUES ('dns_proxy_bypass', 'true')").run();
    getDb().prepare("INSERT OR REPLACE INTO settings VALUES ('dns_forwarder_down', 'true')").run();
    expect(Watchdog.clearBypassAtBoot(getDb())).toBe(true);
    expect(setting('dns_forwarder_down')).toBeNull();
  });
});
