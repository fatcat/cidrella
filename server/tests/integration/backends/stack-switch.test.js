/**
 * Switching the server stack (services/stack-switch.js) through the real
 * registry, with every adapter replaced by a fake that keeps leases, records
 * what it did in one shared log, and fails on request. Covers the order (no
 * daemon that needs a port the source holds starts before the source has
 * stopped), the rollback from each step, and the boot reconciliation.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import dnsPacket from 'dns-packet';

const log = [];
const dnsAnswer = { rcode: 'NOERROR' };

vi.mock('../../../src/utils/plain-dns.js', () => ({
  plainUdpQuery: async (address, query) => {
    if (dnsAnswer.rcode === null) return { answer: null, ms: 0 };
    const { id, questions } = dnsPacket.decode(query);
    const answer = dnsPacket.encode({ id, type: 'response', questions });
    // dns-packet takes no rcode to encode; it is the low four bits of byte 3.
    answer[3] = (answer[3] & 0xf0) | { NOERROR: 0, SERVFAIL: 2, REFUSED: 5 }[dnsAnswer.rcode];
    return { answer, ms: 1 };
  },
  plainTcpQuery: async () => ({ answer: null, ms: 0 }),
}));

// A backend that fills `roles`, logs what it does, and fails an op named in `fail`.
function switchable(createFakeBackend, name, roles, deps, capabilities = {}) {
  const b = createFakeBackend({ name, capabilities });
  const note = (event) => log.push(`${name} ${event}`);
  Object.assign(b, { roles, store: [], duid: null, running: false, fail: {}, drop: [] });
  b.installedResult = { ok: true };
  const failIf = (op) => {
    if (b.fail[op]) throw new Error(b.fail[op]);
  };
  b.dhcp.applyScopes = () => {
    failIf('applyScopes');
    note(`render ${deps.servesDhcp() ? 'serving' : 'quiet'}`);
    return { changed: true, activation: 'reload', activated: false };
  };
  b.ra.applyRouterAdvertisements = () => {
    note('render ra');
    return { changed: true, activation: 'reload', activated: false };
  };
  b.applyActivation = (activation) => {
    if (activation !== 'none') note(`activate ${activation}`);
  };
  b.dhcp.readLeases = async () => ({ leases: b.store.map((lease) => ({ ...lease })) });
  b.dhcp.readStoredLeases = () => b.store.map((lease) => ({ ...lease }));
  b.dhcp.serverIdentity = () => ({ duid: b.duid });
  b.dhcp.importLeases = async (leases, { serverDuid }) => {
    failIf('importLeases');
    b.store = leases.filter((lease) => !b.drop.includes(lease.ip));
    b.duid = serverDuid;
    note(`import ${leases.length}`);
    return { added: leases.length, failed: [] };
  };
  b.stage = async () => {
    failIf('stage');
    note('stage');
  };
  b.activate = () => {
    failIf('activate');
    b.running = true;
    note('start');
    return 'restarted';
  };
  b.restart = () => {
    b.running = true;
    note('start');
  };
  b.stop = () => {
    b.running = false;
    note('stop');
  };
  b.awaitStopped = async () => failIf('awaitStopped');
  b.awaitRunning = async () => failIf('awaitRunning');
  b.status = () => ({ name, label: name, running: b.running, restartPending: false });
  b.installed = () => b.installedResult;
  return b;
}

const fakeHelpers = () => import('../../helpers/fake-backends.js');
const fakeAdapter = (name, roles, capabilities) => async () => {
  const { createFakeBackend } = await fakeHelpers();
  return (deps) => switchable(createFakeBackend, name, roles, deps, capabilities);
};
vi.mock('../../../src/backends/dnsmasq/index.js', async () => ({
  createDnsmasqBackend: await fakeAdapter('dnsmasq', ['dns', 'dhcp', 'ra'])(),
}));
vi.mock('../../../src/backends/kea/index.js', async () => ({
  createKeaBackend: await fakeAdapter('kea', ['dhcp'], { 'forensic-log': true })(),
}));
vi.mock('../../../src/backends/pdns/index.js', async () => ({
  createPdnsBackend: await fakeAdapter('pdns', ['dns'], { 'dns-record-ttl': true })(),
}));
vi.mock('../../../src/backends/radvd/index.js', async () => ({
  createRadvdBackend: await fakeAdapter('radvd', ['ra'])(),
}));

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const registry = await import('../../../src/backends/index.js');
const { readSetting, upsertSetting } = await import('../../../src/models/setting.js');
const { MARKER_FILE, STACK_FILE, SwitchError, selectStackAtBoot, switchStack, switchPreflight } =
  await import('../../../src/services/stack-switch.js');

let db;
let tmpDir;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('lab.test', 'forward', 1)").run();
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

let b;
beforeEach(() => {
  registry.selectStack('dnsmasq');
  registry.setDhcpServing('kea', true);
  db.prepare("DELETE FROM settings WHERE key IN ('backend_stack', 'dhcp_backend')").run();
  fs.rmSync(MARKER_FILE, { force: true });
  b = Object.fromEntries(
    ['dnsmasq', 'kea', 'pdns', 'radvd'].map((name) => [name, registry.getBackend(name)]),
  );
  for (const backend of Object.values(b)) {
    Object.assign(backend, {
      fail: {},
      drop: [],
      store: [],
      duid: null,
      running: false,
      installedResult: { ok: true },
    });
  }
  b.dnsmasq.store = [V4, V6];
  b.dnsmasq.duid = SERVER_DUID;
  b.dnsmasq.running = true;
  dnsAnswer.rcode = 'NOERROR';
  log.length = 0;
});

const at = (entry) => {
  const i = log.indexOf(entry);
  if (i < 0) throw new Error(`"${entry}" is not in the log: ${log.join(' | ')}`);
  return i;
};

describe('switchPreflight', () => {
  it('lists what PowerDNS + Kea adds over dnsmasq', () => {
    const check = switchPreflight('pdns-kea');
    expect(check.blocked).toBeNull();
    expect(check.gained.map((f) => f.id).sort()).toEqual(['dns-record-ttl', 'forensic-log']);
    expect(check.lost).toEqual([]);
    expect(check.stacks.map((s) => s.daemons)).toEqual([['dnsmasq'], ['pdns', 'kea', 'radvd']]);
  });

  it('refuses a stack that cannot run here, the one serving, or an unknown one', () => {
    b.radvd.installedResult = { ok: false, reason: 'radvd is not installed' };
    expect(switchPreflight('pdns-kea').blocked).toBe('radvd is not installed');
    expect(switchPreflight('dnsmasq').blocked).toBe('dnsmasq already serves DNS and DHCP');
    expect(switchPreflight('bind').blocked).toBe('Unknown server stack: bind');
  });

  it('refuses to leave a dnsmasq CIDRella does not run', () => {
    b.dnsmasq.installedResult = { ok: false, reason: 'dnsmasq is not run by CIDRella here' };
    expect(switchPreflight('pdns-kea').blocked).toBe('dnsmasq is not run by CIDRella here');
  });
});

describe('switchStack to PowerDNS + Kea', () => {
  it('moves every role and both families of leases', async () => {
    const result = await switchStack(db, 'pdns-kea');
    expect(result).toMatchObject({ from: 'dnsmasq', to: 'pdns-kea', leases: 2, added: 2 });
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(registry.stackName()).toBe('pdns-kea');
    expect(readSetting(db, 'backend_stack')).toBe('pdns-kea');
    expect(fs.readFileSync(STACK_FILE, 'utf8')).toBe('pdns-kea\n');
    expect(fs.existsSync(MARKER_FILE)).toBe(false);
    expect(b.kea.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    // Clients keep talking to the same DHCPv6 server identity.
    expect(b.kea.duid).toBe(SERVER_DUID);
    expect(b.dnsmasq.running).toBe(false);
  });

  it('stages before dnsmasq stops, and starts nothing contested until it has', async () => {
    await switchStack(db, 'pdns-kea');
    const stopped = at('dnsmasq stop');
    for (const staged of ['pdns stage', 'kea stage', 'radvd stage']) {
      expect(at(staged)).toBeLessThan(stopped);
    }
    // Kea takes the leases before it answers, and Recursor and radvd start after.
    expect(at('kea import 2')).toBeGreaterThan(stopped);
    expect(at('kea render serving')).toBeGreaterThan(at('kea import 2'));
    expect(at('radvd activate reload')).toBeGreaterThan(stopped);
    expect(at('pdns start')).toBeGreaterThan(stopped);
    expect(log).not.toContain('kea render quiet');
  });

  it('keeps the leases it moved, readable by root only', async () => {
    const { snapshot } = await switchStack(db, 'pdns-kea');
    const kept = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    expect(kept).toMatchObject({ from: 'dnsmasq', to: 'pdns-kea', serverDuid: SERVER_DUID });
    expect(kept.leases.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(path.dirname(snapshot)).toBe(path.join(DATA_DIR, 'handover'));
  });

  it('reports a lease the new server took but does not show', async () => {
    b.kea.drop = [V6.ip];
    expect((await switchStack(db, 'pdns-kea')).missing).toEqual([V6.ip]);
  });

  it('moves the 0.5.2 setting out of the way', async () => {
    upsertSetting(db, 'dhcp_backend', 'dnsmasq');
    await switchStack(db, 'pdns-kea');
    expect(readSetting(db, 'dhcp_backend')).toBeNull();
  });

  for (const [backend, op, phase, dnsmasqStopped] of [
    ['pdns', 'stage', 'stage', false],
    ['kea', 'stage', 'stage', false],
    ['dnsmasq', 'awaitStopped', 'stop', true],
    ['kea', 'importLeases', 'import', true],
    ['kea', 'awaitRunning', 'start', true],
    ['radvd', 'awaitRunning', 'start', true],
  ]) {
    it(`puts dnsmasq back when ${backend} fails in ${op}`, async () => {
      b[backend].fail[op] = `${op} broke`;
      const err = await switchStack(db, 'pdns-kea').catch((e) => e);
      expect(err).toBeInstanceOf(SwitchError);
      expect(err).toMatchObject({ phase, rolledBack: true, message: `${op} broke` });
      if (op !== 'awaitStopped') expect(err.rollbackError).toBeNull();
      expect(registry.stackName()).toBe('dnsmasq');
      expect(b.dnsmasq.running).toBe(true);
      for (const name of ['pdns', 'kea', 'radvd']) expect(b[name].running).toBe(false);
      // dnsmasq is started again only if it was stopped.
      expect(log.includes('dnsmasq start')).toBe(dnsmasqStopped);
      expect(readSetting(db, 'backend_stack')).toBeNull();
      expect(fs.existsSync(MARKER_FILE)).toBe(false);
    });
  }

  it('carries back what Kea handed out once it served', async () => {
    b.radvd.fail.awaitRunning = 'no RAs';
    const NEW = { ...V4, ip: '10.60.0.121', mac: 'aa:bb:cc:00:00:0a' };
    const original = b.kea.dhcp.readLeases;
    b.kea.dhcp.readLeases = async () => ({ leases: [...b.kea.store, NEW] });
    await switchStack(db, 'pdns-kea').catch(() => {});
    b.kea.dhcp.readLeases = original;
    expect(b.dnsmasq.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip, NEW.ip]);
    expect(at('dnsmasq import 3')).toBeLessThan(at('dnsmasq start'));
  });

  it('puts dnsmasq back when the new DNS does not answer for a zone', async () => {
    dnsAnswer.rcode = 'SERVFAIL';
    const err = await switchStack(db, 'pdns-kea').catch((e) => e);
    expect(err).toMatchObject({ phase: 'verify', rolledBack: true });
    expect(err.message).toBe('DNS does not answer for lab.test (SERVFAIL)');
    expect(registry.stackName()).toBe('dnsmasq');
  }, 20000);

  it('refuses a second switch while one runs', async () => {
    const first = switchStack(db, 'pdns-kea');
    await expect(switchStack(db, 'pdns-kea')).rejects.toMatchObject({
      phase: 'preflight',
      message: 'A server switch is already running',
    });
    await first;
  });
});

describe('switchStack back to dnsmasq', () => {
  beforeEach(async () => {
    await switchStack(db, 'pdns-kea');
    b.dnsmasq.store = [];
    log.length = 0;
  });

  it('quiets Kea, carries its leases and stops the stack before dnsmasq starts', async () => {
    const result = await switchStack(db, 'dnsmasq');
    expect(result).toMatchObject({ from: 'pdns-kea', to: 'dnsmasq', leases: 2 });
    expect(registry.stackName()).toBe('dnsmasq');
    expect(readSetting(db, 'backend_stack')).toBe('dnsmasq');
    expect(b.dnsmasq.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    expect(b.dnsmasq.duid).toBe(SERVER_DUID);
    expect(at('dnsmasq stage')).toBeLessThan(at('kea render quiet'));
    expect(at('kea render quiet')).toBeLessThan(at('dnsmasq import 2'));
    const started = at('dnsmasq start');
    for (const name of ['radvd', 'kea', 'pdns']) expect(at(`${name} stop`)).toBeLessThan(started);
    for (const name of ['pdns', 'kea', 'radvd']) expect(b[name].running).toBe(false);
  });

  it('puts PowerDNS + Kea back, Kea serving, when dnsmasq does not come up', async () => {
    b.dnsmasq.fail.awaitRunning = 'dnsmasq would not start';
    const err = await switchStack(db, 'dnsmasq').catch((e) => e);
    expect(err).toMatchObject({ phase: 'start', rolledBack: true, rollbackError: null });
    expect(registry.stackName()).toBe('pdns-kea');
    expect(registry.servesDhcp('kea')).toBe(true);
    expect(b.dnsmasq.running).toBe(false);
    expect(log.at(-1)).toBe('kea import 2');
  });

  it('puts Kea back to serving when the stage fails', async () => {
    b.dnsmasq.fail.stage = 'dnsmasq --test refused';
    const err = await switchStack(db, 'dnsmasq').catch((e) => e);
    expect(err).toMatchObject({ phase: 'stage', rolledBack: true });
    expect(registry.servesDhcp('kea')).toBe(true);
    expect(log).not.toContain('kea import 2');
  });
});

describe('selectStackAtBoot', () => {
  it('takes the stack from the setting and stops what is outside it', async () => {
    upsertSetting(db, 'backend_stack', 'pdns-kea');
    b.dnsmasq.running = true;
    expect(await selectStackAtBoot(db)).toEqual({ stack: 'pdns-kea', recovered: null });
    expect(registry.stackName()).toBe('pdns-kea');
    expect(b.dnsmasq.running).toBe(false);
    expect(fs.readFileSync(STACK_FILE, 'utf8')).toBe('pdns-kea\n');
  });

  it('defaults to dnsmasq and stops a stray Kea', async () => {
    b.kea.running = true;
    expect((await selectStackAtBoot(db)).stack).toBe('dnsmasq');
    expect(readSetting(db, 'backend_stack')).toBe('dnsmasq');
    expect(b.kea.running).toBe(false);
    // Daemons that were not running are left alone.
    expect(log).not.toContain('radvd stop');
  });

  it("moves 0.5.2's Kea DHCP back to dnsmasq with Kea's leases and DUID", async () => {
    upsertSetting(db, 'dhcp_backend', 'kea');
    b.kea.store = [V4, V6];
    b.kea.duid = SERVER_DUID;
    b.kea.running = true;
    b.dnsmasq.store = [];
    expect((await selectStackAtBoot(db)).stack).toBe('dnsmasq');
    expect(b.dnsmasq.store.map((lease) => lease.ip)).toEqual([V4.ip, V6.ip]);
    expect(b.dnsmasq.duid).toBe(SERVER_DUID);
    expect(at('kea stop')).toBeLessThan(at('dnsmasq import 2'));
    expect(at('dnsmasq stop')).toBeLessThan(at('dnsmasq import 2'));
    expect(readSetting(db, 'dhcp_backend')).toBeNull();
    expect(readSetting(db, 'backend_stack')).toBe('dnsmasq');
  });

  it("reads a stopped Kea's lease files", async () => {
    upsertSetting(db, 'dhcp_backend', 'kea');
    b.kea.store = [V4];
    b.dnsmasq.store = [];
    await selectStackAtBoot(db);
    expect(b.dnsmasq.store.map((lease) => lease.ip)).toEqual([V4.ip]);
  });

  it('falls back to dnsmasq, with the leases, when the stack cannot run here', async () => {
    upsertSetting(db, 'backend_stack', 'pdns-kea');
    b.pdns.installedResult = { ok: false, reason: 'PowerDNS is not installed' };
    b.kea.store = [V6];
    b.dnsmasq.store = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await selectStackAtBoot(db)).stack).toBe('dnsmasq');
    error.mockRestore();
    expect(readSetting(db, 'backend_stack')).toBe('dnsmasq');
    expect(b.dnsmasq.store.map((lease) => lease.ip)).toEqual([V6.ip]);
  });

  it('undoes a switch a crash interrupted', async () => {
    b.kea.running = true;
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ from: 'dnsmasq', to: 'pdns-kea' }));
    const { stack, recovered } = await selectStackAtBoot(db);
    expect(stack).toBe('dnsmasq');
    expect(recovered).toMatchObject({ from: 'dnsmasq', to: 'pdns-kea', finished: false });
    expect(b.kea.running).toBe(false);
    expect(fs.existsSync(MARKER_FILE)).toBe(false);
  });

  it('only cleans up after a switch that recorded its setting', async () => {
    upsertSetting(db, 'backend_stack', 'pdns-kea');
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ from: 'dnsmasq', to: 'pdns-kea' }));
    const { stack, recovered } = await selectStackAtBoot(db);
    expect(stack).toBe('pdns-kea');
    expect(recovered.finished).toBe(true);
  });
});
