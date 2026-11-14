/**
 * A scan that throws before its probe loop still ends (SCAN-SETUP-STRANDED-01).
 *
 * Callers start a full scan without waiting for it. A throw in the setup used
 * to reach only the global rejection handler and leave the row pending, and a
 * pending row makes createPendingIfIdle refuse every later scan of the subnet.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../helpers/test-db.js';

// Nothing answers: no real probe leaves the test.
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => cb(new Error('no reply'), ''),
  execFileSync: vi.fn(),
}));
vi.mock('../../src/utils/nd-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readNdCache: () => new Map(),
  lookupNdEntry: () => null,
}));
vi.mock('../../src/utils/arp-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readArpCache: () => new Map(),
}));

const { startScan, startScanInBackground } = await import('../../src/utils/scanner.js');
const { parseNetwork } = await import('../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../src/services/subnet-topology.js');
const ScanRun = await import('../../src/models/scan-run.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');

let db;
let tmpDir;

function network(cidr) {
  const id = insertSubnet(db, {
    cidr,
    name: cidr,
    status: 'unallocated',
    depth: 0,
  }).lastInsertRowid;
  const parsed = parseNetwork(cidr);
  configureSubnet(db, db.prepare('SELECT * FROM subnets WHERE id = ?').get(id), parsed, {
    name: cidr,
    gateway: parsed.firstUsable,
    gateway_policy: 'first',
    create_dhcp_scope: false,
  });
  invalidateSubnetCache();
  return Number(id);
}

const status = (scanId) =>
  db.prepare('SELECT status, error FROM network_scans WHERE id = ?').get(scanId);

// The setup reads ip_addresses before the probe loop; without it, it throws.
function breakSetup() {
  db.exec('ALTER TABLE ip_addresses RENAME TO ip_addresses_hidden');
}
function repairSetup() {
  db.exec('ALTER TABLE ip_addresses_hidden RENAME TO ip_addresses');
}

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  db = setup.db;
  tmpDir = setup.tmpDir;
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      { family: 'IPv4', address: '10.72.0.6', internal: false },
      { family: 'IPv6', address: 'fd00:72::2', internal: false },
    ],
  });
});

afterEach(() => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ip_addresses_hidden'").get()) {
    repairSetup();
  }
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe.each([
  ['IPv4', '10.72.0.0/29'],
  ['IPv6', 'fd00:72::/64'],
])('a setup failure, %s', (_family, cidr) => {
  it('marks the scan failed, so the next scan of the subnet can start', async () => {
    const subnetId = network(cidr);
    const first = ScanRun.createPendingIfIdle(db, subnetId);
    breakSetup();
    await expect(startScan(db, first.scanId, subnetId)).rejects.toThrow(/ip_addresses/);
    repairSetup();

    expect(status(first.scanId)).toMatchObject({ status: 'failed' });
    expect(status(first.scanId).error).toMatch(/ip_addresses/);
    expect(ScanRun.createPendingIfIdle(db, subnetId).created).toBe(true);
  });

  it('is logged, not left as an unhandled rejection, when nobody waits', async () => {
    const subnetId = network(cidr.replace('72', '73'));
    const scan = ScanRun.createPendingIfIdle(db, subnetId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    breakSetup();
    let logged;
    try {
      startScanInBackground(db, scan.scanId, subnetId);
      await vi.waitFor(() => expect(status(scan.scanId).status).toBe('failed'));
      await new Promise((resolve) => setImmediate(resolve));
      logged = errors.mock.calls.flat().join(' ');
    } finally {
      process.off('unhandledRejection', unhandled);
      errors.mockRestore();
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(logged).toMatch(new RegExp(`Scan #${scan.scanId}`));
  });
});
