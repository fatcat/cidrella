/**
 * Switching the DHCP server (services/dhcp-backend-switch.js) through the
 * real registry, with both adapters replaced by fakes that keep leases, honor
 * servesDhcp, and fail on request. Covers the order of the handover, the
 * rollback from each step, and the boot recovery after a crash.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';

const fakes = {};

// A backend that fills `roles`, records what it rendered, and fails an op
// named in `fail`.
function switchable(createFakeBackend, name, roles, deps, capabilities = {}) {
  const b = createFakeBackend({ name, capabilities });
  Object.assign(b, {
    roles,
    events: [],
    store: [],
    duid: null,
    running: name === 'dnsmasq',
    fail: {},
    installedResult: { ok: true },
  });
  const failIf = (op) => {
    if (b.fail[op]) throw new Error(b.fail[op]);
  };
  b.dhcp.applyScopes = () => {
    failIf('applyScopes');
    b.mode = deps.servesDhcp() ? 'serving' : 'quiet';
    b.events.push(`render ${b.mode}`);
    return { changed: true, activation: 'reload', activated: false };
  };
  b.ra.applyRouterAdvertisements = () => {
    b.events.push('render ra');
    return { changed: false, activation: 'none', activated: false };
  };
  b.dhcp.readLeases = async () => ({ leases: b.store.map((lease) => ({ ...lease })) });
  b.dhcp.serverIdentity = () => ({ duid: b.duid });
  b.dhcp.importLeases = async (leases, { serverDuid }) => {
    failIf('importLeases');
    b.store = leases.filter((lease) => !b.drop?.includes(lease.ip));
    b.duid = serverDuid;
    b.events.push(`import ${leases.length}`);
    return { added: leases.length, failed: [] };
  };
  b.activate = () => {
    b.running = true;
    return 'restarted';
  };
  b.awaitRunning = async () => {
    failIf(b.mode === 'serving' ? 'awaitServing' : 'awaitRunning');
  };
  b.stop = () => {
    b.running = false;
    b.events.push('stop');
  };
  b.installed = () => b.installedResult;
  fakes[name] = b;
  return b;
}

const fakeHelpers = () => import('../../helpers/fake-backends.js');
vi.mock('../../../src/backends/dnsmasq/index.js', async () => {
  const { createFakeBackend } = await fakeHelpers();
  return {
    createDnsmasqBackend: (deps) =>
      switchable(createFakeBackend, 'dnsmasq', ['dns', 'dhcp', 'ra'], deps),
  };
});
vi.mock('../../../src/backends/kea/index.js', async () => {
  const { createFakeBackend } = await fakeHelpers();
  return {
    createKeaBackend: (deps) =>
      switchable(createFakeBackend, 'kea', ['dhcp'], deps, {
        'dhcp-relay': true,
        'forensic-log': true,
      }),
  };
});

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const registry = await import('../../../src/backends/index.js');
const { readSetting, upsertSetting } = await import('../../../src/models/setting.js');
const { MARKER_FILE, SwitchError, selectDhcpBackendAtBoot, switchDhcpBackend, switchPreflight } =
  await import('../../../src/services/dhcp-backend-switch.js');

let db;
let tmpDir;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});
afterAll(() => {
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const V4 = {
  ip: '10.60.0.120',
  mac: 'aa:bb:cc:00:00:09',
  hostname: 'laptop',
  clientId: null,
  expiresAt: '2030-01-01T00:00:00.000Z',
  dhcpVersion: 4,
  duid: null,
  iaid: null,
};
const V6 = {
  ip: 'fd00:63::120',
  mac: null,
  hostname: 'phone',
  clientId: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
  expiresAt: 'infinite',
  dhcpVersion: 6,
  duid: '00:01:00:01:aa:bb:cc:dd:ee:ff:00:11:22:33',
  iaid: 3,
};
const SERVER_DUID = '00:01:00:01:2e:8f:11:22:52:54:00:aa:bb:cc';

let dnsmasq;
let kea;
beforeEach(() => {
  registry.selectDhcpBackend('dnsmasq');
  for (const name of registry.DHCP_BACKENDS) registry.setDhcpServing(name, true);
  db.prepare("DELETE FROM settings WHERE key = 'dhcp_backend'").run();
  fs.rmSync(MARKER_FILE, { force: true });
  dnsmasq = registry.getBackend('dnsmasq');
  kea = registry.getBackend('kea');
  for (const b of [dnsmasq, kea]) {
    Object.assign(b, { events: [], fail: {}, drop: [], installedResult: { ok: true } });
  }
  dnsmasq.store = [V4, V6];
  dnsmasq.duid = SERVER_DUID;
  dnsmasq.running = true;
  kea.store = [];
  kea.duid = null;
  kea.running = false;
});

describe('switchPreflight', () => {
  it('lists what Kea adds over dnsmasq', () => {
    const check = switchPreflight('kea');
    expect(check.blocked).toBeNull();
    expect(check.gained.map((f) => f.id).sort()).toEqual(['dhcp-relay', 'forensic-log']);
    expect(check.lost).toEqual([]);
  });

  it('refuses a backend that is not installed, or the one already serving', () => {
    kea.installedResult = { ok: false, reason: 'Kea is not installed: kea-dhcp4 was not found' };
    expect(switchPreflight('kea').blocked).toBe('Kea is not installed: kea-dhcp4 was not found');
    expect(switchPreflight('dnsmasq').blocked).toBe('dnsmasq already serves DHCP');
    expect(switchPreflight('isc-dhcpd').blocked).toBe('Unknown DHCP server: isc-dhcpd');
  });
});

describe('switchDhcpBackend', () => {
  it('moves DHCP and both families of leases from dnsmasq to Kea', async () => {
    const result = await switchDhcpBackend(db, 'kea');
    expect(result).toMatchObject({ from: 'dnsmasq', to: 'kea', leases: 2, added: 2 });
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);

    expect(registry.getService('dhcp')).toBe(kea);
    expect(readSetting(db, 'dhcp_backend')).toBe('kea');
    expect(fs.existsSync(MARKER_FILE)).toBe(false);
    expect(kea.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    // Clients keep talking to the same DHCPv6 server identity.
    expect(kea.duid).toBe(SERVER_DUID);
    // dnsmasq stops answering before Kea takes the leases, and keeps sending
    // the RAs; Kea answers only once it has them.
    expect(dnsmasq.events).toEqual(['render quiet', 'render ra', 'render ra']);
    expect(kea.events).toEqual(['render quiet', 'import 2', 'render serving']);
    expect(dnsmasq.running).toBe(true);
  });

  it('moves no leases from a server that has never stored one', async () => {
    const read = dnsmasq.dhcp.readLeases;
    dnsmasq.dhcp.readLeases = async () => ({ leases: null, absent: true });
    try {
      const result = await switchDhcpBackend(db, 'kea');
      expect(result).toMatchObject({ to: 'kea', leases: 0, added: 0 });
      expect(registry.getService('dhcp')).toBe(kea);
    } finally {
      dnsmasq.dhcp.readLeases = read;
    }
  });

  it('keeps the leases it moved, readable by root only', async () => {
    const { snapshot } = await switchDhcpBackend(db, 'kea');
    const kept = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    expect(kept).toMatchObject({ from: 'dnsmasq', to: 'kea', serverDuid: SERVER_DUID });
    expect(kept.leases.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);
  });

  it('moves back to dnsmasq and stops Kea', async () => {
    await switchDhcpBackend(db, 'kea');
    dnsmasq.store = [];
    const result = await switchDhcpBackend(db, 'dnsmasq');
    expect(result).toMatchObject({ from: 'kea', to: 'dnsmasq', leases: 2 });
    expect(registry.getService('dhcp')).toBe(dnsmasq);
    expect(readSetting(db, 'dhcp_backend')).toBe('dnsmasq');
    expect(dnsmasq.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    expect(dnsmasq.mode).toBe('serving');
    expect(kea.running).toBe(false);
  });

  it('reports a lease the new server took but does not show', async () => {
    kea.drop = [V6.ip];
    const result = await switchDhcpBackend(db, 'kea');
    expect(result.missing).toEqual([V6.ip]);
  });

  for (const [op, phase] of [
    ['importLeases', 'import'],
    ['awaitRunning', 'import'],
    ['awaitServing', 'serve'],
  ]) {
    it(`puts dnsmasq back when Kea fails in ${op}`, async () => {
      kea.fail[op] = `${op} broke`;
      const err = await switchDhcpBackend(db, 'kea').catch((e) => e);
      expect(err).toBeInstanceOf(SwitchError);
      expect(err).toMatchObject({ phase, rolledBack: true, rollbackError: null });
      expect(err.message).toBe(`${op} broke`);
      expect(registry.getService('dhcp')).toBe(dnsmasq);
      expect(dnsmasq.mode).toBe('serving');
      expect(kea.running).toBe(false);
      expect(readSetting(db, 'dhcp_backend')).toBeNull();
      expect(fs.existsSync(MARKER_FILE)).toBe(false);
    });
  }

  it('says when putting the source back failed too', async () => {
    kea.fail.importLeases = 'refused';
    const realRender = dnsmasq.dhcp.applyScopes;
    let renders = 0;
    dnsmasq.dhcp.applyScopes = (...args) => {
      renders++;
      if (renders > 1) throw new Error('dnsmasq would not start');
      return realRender(...args);
    };
    const err = await switchDhcpBackend(db, 'kea').catch((e) => e);
    dnsmasq.dhcp.applyScopes = realRender;
    expect(err).toMatchObject({ phase: 'import', rolledBack: true });
    expect(err.rollbackError).toBe('dnsmasq would not start');
  });

  it('refuses a second switch while one runs', async () => {
    const first = switchDhcpBackend(db, 'kea');
    await expect(switchDhcpBackend(db, 'kea')).rejects.toMatchObject({
      phase: 'preflight',
      message: 'A DHCP server switch is already running',
    });
    await first;
  });
});

describe('selectDhcpBackendAtBoot', () => {
  it('takes the backend from the setting', () => {
    upsertSetting(db, 'dhcp_backend', 'kea');
    expect(selectDhcpBackendAtBoot(db)).toEqual({ backend: 'kea', recovered: null });
    expect(registry.getService('dhcp')).toBe(kea);
  });

  it('falls back to dnsmasq when Kea cannot run here, and records it', () => {
    upsertSetting(db, 'dhcp_backend', 'kea');
    kea.installedResult = { ok: false, reason: 'Kea is not installed' };
    expect(selectDhcpBackendAtBoot(db).backend).toBe('dnsmasq');
    expect(readSetting(db, 'dhcp_backend')).toBe('dnsmasq');
  });

  it('undoes a switch a crash interrupted', () => {
    kea.running = true;
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ from: 'dnsmasq', to: 'kea' }));
    const { backend, recovered } = selectDhcpBackendAtBoot(db);
    expect(backend).toBe('dnsmasq');
    expect(recovered).toMatchObject({ from: 'dnsmasq', to: 'kea', finished: false });
    expect(kea.running).toBe(false);
    expect(fs.existsSync(MARKER_FILE)).toBe(false);
  });

  it('only cleans up after a switch that recorded its setting', () => {
    upsertSetting(db, 'dhcp_backend', 'kea');
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ from: 'dnsmasq', to: 'kea' }));
    const { backend, recovered } = selectDhcpBackendAtBoot(db);
    expect(backend).toBe('kea');
    expect(recovered.finished).toBe(true);
    expect(dnsmasq.running).toBe(true);
  });
});
