/**
 * What the Kea adapter does for a switch of the DHCP server
 * (services/dhcp-backend-switch.js): rendering while it answers no DHCP,
 * taking another server's leases and DUID, and saying when it is ready.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { seedBackendEstate } = await import('../../../helpers/backend-estate.js');
const { startFakeKea } = await import('../../../helpers/fake-kea.js');
const { ensureKeaSecret } = await import('../../../../src/backends/kea/secret.js');
const { confPath, SERVER_DUID_FILE } = await import('../../../../src/backends/kea/paths.js');

let db;
let tmpDir;
let kea;
let createKeaBackend;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  seedBackendEstate(db);
  kea = await startFakeKea({ password: ensureKeaSecret() });
  process.env.KEA_CONTROL_PORT4 = String(kea.port);
  process.env.KEA_CONTROL_PORT6 = String(kea.v6Port);
  ({ createKeaBackend } = await import('../../../../src/backends/kea/index.js'));
});
afterAll(async () => {
  await kea?.close();
  delete process.env.KEA_CONTROL_PORT4;
  delete process.env.KEA_CONTROL_PORT6;
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let serving;
const backend = (deps = {}) =>
  createKeaBackend({
    exec: () => '',
    families: () => [4, 6],
    interfaces: () => ['eth0'],
    servesDhcp: () => serving,
    wait: async () => {},
    ...deps,
  });

const listening = (family) =>
  JSON.parse(fs.readFileSync(confPath(family), 'utf8'))[`Dhcp${family}`]['interfaces-config']
    .interfaces;

beforeEach(() => {
  serving = true;
  kea.sockets = 'ready';
  for (const family of [4, 6]) kea.leases[family].clear();
  fs.rmSync(SERVER_DUID_FILE, { force: true });
});

describe('rendering while not serving', () => {
  it('listens nowhere until it serves, in both families', () => {
    const kea = backend();
    serving = false;
    kea.dhcp.applyScopes(db, { activate: false });
    expect(listening(4)).toEqual([]);
    expect(listening(6)).toEqual([]);
    serving = true;
    expect(kea.dhcp.applyScopes(db, { activate: false }).changed).toBe(true);
    expect(listening(4)).toEqual(['eth0']);
    expect(listening(6)).toEqual(['eth0']);
  });
});

describe('importLeases', () => {
  const v4 = {
    ip: '10.60.0.150',
    mac: 'aa:bb:cc:00:00:01',
    hostname: 'laptop',
    clientId: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    dhcpVersion: 4,
    duid: null,
    iaid: null,
  };
  const v6 = {
    ip: 'fd00:60::150',
    mac: null,
    hostname: 'phone',
    clientId: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    dhcpVersion: 6,
    duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
    iaid: 7,
  };

  it('replaces what Kea held with the handed-over leases, both families', async () => {
    kea.leases[4].set('10.60.0.199', { 'ip-address': '10.60.0.199', state: 2 });
    kea.leases[6].set('fd00:60::199', { 'ip-address': 'fd00:60::199', state: 0 });
    const result = await backend().dhcp.importLeases([v4, v6], {});
    expect(result).toEqual({ added: 2, failed: [] });
    expect([...kea.leases[4].keys()]).toEqual(['10.60.0.150']);
    expect([...kea.leases[6].keys()]).toEqual(['fd00:60::150']);
  });

  it('keeps the DHCPv6 server DUID the leases were handed out under', async () => {
    const duid = '00:01:00:01:2e:8f:11:22:52:54:00:aa:bb:cc';
    const k = backend();
    await k.dhcp.importLeases([], { serverDuid: duid });
    expect(k.dhcp.serverIdentity()).toEqual({ duid });
  });
});

describe('installed', () => {
  it('is ok when both daemons can run', () => {
    expect(backend({ access: () => {} }).installed()).toEqual({ ok: true });
  });

  it('names the missing binary', () => {
    const result = backend({
      access: () => {
        throw new Error('ENOENT');
      },
    }).installed();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Kea is not installed: .*kea-dhcp4/);
  });
});

describe('awaitRunning', () => {
  it('resolves once the sockets are open', async () => {
    await expect(backend().awaitRunning()).resolves.toBeUndefined();
  });

  it('rejects when Kea could not open its sockets', async () => {
    kea.sockets = 'failed';
    await expect(backend().awaitRunning()).rejects.toThrow('could not open its sockets');
  });

  it('gives up on sockets that never become ready', async () => {
    kea.sockets = 'retrying';
    await expect(backend().awaitRunning({ timeoutMs: 0 })).rejects.toThrow(
      'kea-dhcp4 is not ready: sockets retrying',
    );
  });

  it('needs only an answer while it serves nothing', async () => {
    serving = false;
    kea.sockets = 'retrying';
    await expect(backend().awaitRunning({ timeoutMs: 0 })).resolves.toBeUndefined();
  });
});
