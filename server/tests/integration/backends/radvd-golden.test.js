/**
 * Golden output of the radvd backend: the DHCPv6 scopes of the backend
 * estate (one per mode) rendered to radvd.conf, two on one interface and
 * one on another, and checked with `radvd --configtest`. The live test on a
 * Debian 13 host compared these Router Advertisements with dnsmasq's.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const commands = [];
const exec = vi.fn((cmd, args = []) => {
  commands.push([cmd, ...args.map((a) => a.replace(DATA_DIR, '$DATA_DIR'))].join(' '));
  return '';
});
// systemctl answers without running.
vi.mock('../../../src/utils/run-command.js', async () =>
  (await import('../../helpers/fake-run-command.js')).fakeRunCommandModule(() => ''),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { ESTATE_INTERFACES, seedBackendEstate } = await import('../../helpers/backend-estate.js');
const { createRadvdBackend } = await import('../../../src/backends/radvd/index.js');

let db;
let tmpDir;
let ifaces;

const RADVD_CONF = path.join(DATA_DIR, 'radvd', 'radvd.conf');
const golden = (step) => `./__golden__/${step}.txt`;
const snapshot = () =>
  [
    '=== radvd.conf ===',
    fs.readFileSync(RADVD_CONF, 'utf8'),
    '=== commands ===',
    ...commands,
    '',
  ].join('\n');

// eth0 carries the SLAAC and the stateful network, eth1 the stateless one.
const estateInterfaces = () => ({
  ...ESTATE_INTERFACES,
  eth0: [
    ...ESTATE_INTERFACES.eth0,
    { family: 'IPv6', address: 'fd00:61::2', internal: false },
    { family: 'IPv6', address: 'fd00:63::2', internal: false },
  ],
  eth1: [...ESTATE_INTERFACES.eth1, { family: 'IPv6', address: 'fd00:62::2', internal: false }],
});

const backend = () =>
  createRadvdBackend({
    exec,
    sysIfaces: () => ifaces,
    readMtu: (name) => (name === 'eth0' ? 1500 : null),
  });

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  seedBackendEstate(db);
  ifaces = estateInterfaces();
  // The scope model offers CIDRella's own address on the network as the DNS
  // server (option 23) when the scope names none, as dnsmasq does in its RAs.
  vi.spyOn(os, 'networkInterfaces').mockImplementation(() => ifaces);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('radvd backend golden output', () => {
  it('renders every DHCPv6 scope on the interface holding its network', async () => {
    const result = backend().ra.applyRouterAdvertisements(db, { activate: false });
    expect(result).toEqual({ changed: true, activation: 'reload', activated: false });
    await expect(snapshot()).toMatchFileSnapshot(golden('radvd-01-ra'));
  });

  it('renders nothing new and runs no check when nothing changed', () => {
    commands.length = 0;
    expect(backend().ra.applyRouterAdvertisements(db, { activate: false }).changed).toBe(false);
    expect(commands).toEqual([]);
  });

  it('leaves out a scope no interface holds an address in, and says so', () => {
    ifaces = { ...estateInterfaces(), eth1: ESTATE_INTERFACES.eth1 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend().ra.applyRouterAdvertisements(db, { activate: false });
    expect(warn).toHaveBeenCalledWith(
      'radvd: no DHCP interface has an address in fd00:62::/64; not advertised',
    );
    warn.mockRestore();
    const text = fs.readFileSync(RADVD_CONF, 'utf8');
    expect(text).not.toContain('fd00:62::');
    expect(text).not.toContain('interface eth1');
    ifaces = estateInterfaces();
  });

  it('writes an idle file, never checked, when nothing is left to advertise', async () => {
    ifaces = ESTATE_INTERFACES;
    commands.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const radvd = backend();
    radvd.ra.applyRouterAdvertisements(db, { activate: false });
    warn.mockRestore();
    expect(fs.readFileSync(RADVD_CONF, 'utf8')).toMatch(/^# No DHCPv6 scope to advertise/);
    expect(commands).toEqual([]);
    expect((await radvd.status()).idle).toBe(true);
    ifaces = estateInterfaces();
  });
});
