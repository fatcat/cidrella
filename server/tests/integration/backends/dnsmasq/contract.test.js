/**
 * The dnsmasq adapter against the backend contract, writing real config files
 * into a temp DATA_DIR. dnsmasq itself is not run: child_process is mocked,
 * so validation and restarts succeed.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd, args = []) =>
    cmd === 'dnsmasq' && args[0] === '--version' ? 'Compile time options: IPv6 DHCP DNSSEC' : '',
  ),
  execSync: vi.fn(() => ''),
  execFile: vi.fn(),
}));

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { createDnsmasqBackend } = await import('../../../../src/backends/dnsmasq/index.js');
const { runBackendContract } = await import('../../../contract/backend-contract.js');

const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');
const EXPIRY = (iso) => Math.floor(Date.parse(iso) / 1000);

// dnsmasq's lease-file line for a BackendLease.
function leaseLine(lease) {
  const hostname = lease.hostname || '*';
  if (lease.dhcpVersion === 6) {
    const iaid = `${lease.temporary ? 'T' : ''}${lease.iaid}`;
    return `${EXPIRY(lease.expiresAt)} ${iaid} ${lease.ip} ${hostname} ${lease.clientId || '*'}`;
  }
  return `${EXPIRY(lease.expiresAt)} ${lease.mac} ${lease.ip} ${hostname} ${lease.clientId || '*'}`;
}

let tmpDir;
afterAll(() => {
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

runBackendContract('dnsmasq', async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  enableIpv6(setup.db);
  fs.copyFileSync(
    path.resolve(__dirname, '../../../../../dnsmasq/dnsmasq.conf.default'),
    path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.conf'),
  );
  return {
    backend: createDnsmasqBackend(),
    db: setup.db,
    readOptions: { settleMs: 0, attempts: 2 },
    seedLeases(leases) {
      const v4 = leases.filter((lease) => lease.dhcpVersion === 4).map(leaseLine);
      const v6 = leases.filter((lease) => lease.dhcpVersion === 6).map(leaseLine);
      const server = v6.length ? ['duid 00:01:00:01:11:22:33:44:52:54:00:00:00:01'] : [];
      fs.writeFileSync(LEASE_FILE, [...v4, ...server, ...v6, ''].join('\n'));
    },
    tearLeases() {
      fs.writeFileSync(LEASE_FILE, '4102444800 aa:bb:cc:00:25:50 10.250.0.50 lap');
    },
  };
});
