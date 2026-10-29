/**
 * The radvd adapter against the backend contract, writing radvd.conf into a
 * temp DATA_DIR. `radvd --configtest` is not run (the check is injected and
 * passes); the golden test and the live check cover what radvd accepts.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { afterAll, vi } from 'vitest';
import fs from 'fs';

// systemctl, pkill and rec_control succeed without running anything.
vi.mock('../../../../src/utils/run-command.js', async () =>
  (await import('../../../helpers/fake-run-command.js')).fakeRunCommandModule(() => ''),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { runBackendContract } = await import('../../../contract/backend-contract.js');

let tmpDir;
afterAll(() => {
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

runBackendContract('radvd', async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  enableIpv6(setup.db);
  const { createRadvdBackend } = await import('../../../../src/backends/radvd/index.js');
  return {
    backend: createRadvdBackend({ exec: () => '', sysIfaces: () => ({}), readMtu: () => null }),
    db: setup.db,
    readOptions: {},
    seedLeases() {},
  };
});
