/**
 * A scan while the privileged helper is not answering fails, saying so,
 * instead of recording every address as not responding (which would mark a
 * whole network offline and, a day later, retire its hosts). Either family:
 * IPv4 stops at its first arping, IPv6 at its all-nodes discovery echo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../helpers/test-db.js';

// The helper driver, with a helper that never answers.
vi.mock('../../src/utils/helper-client.js', () => ({
  helperRun: vi.fn(async () => null),
  helperPeer: () => null,
  helperConnected: () => false,
  startHelperClient: vi.fn(),
}));
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => cb(new Error('the web app ran a probe itself'), '')),
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

const { startScan } = await import('../../src/utils/scanner.js');
const { parseNetwork } = await import('../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../src/services/subnet-topology.js');
const ScanRun = await import('../../src/models/scan-run.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { helperRun } = await import('../../src/utils/helper-client.js');
const { execFile } = await import('child_process');

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

beforeAll(async () => {
  process.env.CIDRELLA_HELPER_SOCKET = '/nonexistent/helper.sock';
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  db = setup.db;
  tmpDir = setup.tmpDir;
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      { family: 'IPv4', address: '10.74.0.6', internal: false },
      { family: 'IPv6', address: 'fd00:74::2', internal: false },
    ],
  });
});

afterAll(() => {
  delete process.env.CIDRELLA_HELPER_SOCKET;
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe.each([
  ['IPv4', '10.74.0.0/29', 'arping'],
  ['IPv6', 'fd00:74::/64', 'ping'],
])('a scan with the helper down, %s', (_family, cidr, firstOp) => {
  it('fails with the reason and records no host as not responding', async () => {
    const subnetId = network(cidr);
    const scan = ScanRun.createPendingIfIdle(db, subnetId);
    helperRun.mockClear();
    await expect(startScan(db, scan.scanId, subnetId)).rejects.toThrow(
      /privileged helper is not answering/,
    );

    const run = db.prepare('SELECT status, error FROM network_scans WHERE id = ?').get(scan.scanId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/privileged helper is not answering/);
    expect(helperRun.mock.calls[0][0]).toBe(firstOp);
    expect(execFile).not.toHaveBeenCalled();
    const unanswered = db
      .prepare('SELECT COUNT(*) AS n FROM scan_results WHERE scan_id = ? AND responded = 0')
      .get(scan.scanId);
    expect(unanswered.n).toBe(0);
  });
});
