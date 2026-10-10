/**
 * The Kea adapter against the backend contract, writing real config files
 * into a temp DATA_DIR and talking to a fake Kea control API. `kea-dhcp4 -t`
 * is not run (the check is injected and passes); the golden test and the
 * live test cover what real Kea accepts.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { afterAll } from 'vitest';
import fs from 'fs';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { startFakeKea } = await import('../../../helpers/fake-kea.js');
const { ensureKeaSecret } = await import('../../../../src/backends/kea/secret.js');
const { keaLeaseArguments } = await import('../../../../src/backends/kea/leases.js');
const { runBackendContract } = await import('../../../contract/backend-contract.js');

let tmpDir;
let kea;
afterAll(async () => {
  await kea?.close();
  delete process.env.KEA_CONTROL_PORT4;
  delete process.env.KEA_CONTROL_PORT6;
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

runBackendContract('kea', async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  enableIpv6(setup.db);
  kea = await startFakeKea({ password: ensureKeaSecret() });
  process.env.KEA_CONTROL_PORT4 = String(kea.port);
  process.env.KEA_CONTROL_PORT6 = String(kea.v6Port);
  const { createKeaBackend } = await import('../../../../src/backends/kea/index.js');
  return {
    backend: createKeaBackend({
      exec: () => '',
      families: () => [4, 6],
      interfaces: () => ['eth0'],
    }),
    db: setup.db,
    readOptions: {},
    // Kea stores what lease4-add / lease6-add were given.
    seedLeases(leases) {
      for (const family of [4, 6]) kea.leases[family].clear();
      const now = Date.now();
      for (const lease of leases) {
        const args = keaLeaseArguments(lease, { now });
        kea.leases[lease.dhcpVersion].set(lease.ip, {
          ...args,
          cltt: args.expire - args['valid-lft'],
          state: 0,
        });
      }
    },
    tearLeases() {
      kea.churn = true;
    },
  };
});
