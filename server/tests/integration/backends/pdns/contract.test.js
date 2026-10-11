/**
 * The PowerDNS adapter against the backend contract, writing recursor.yml
 * into a temp DATA_DIR and talking to a fake Authoritative API. Recursor's
 * config check and rec_control are injected and succeed; the live test
 * covers what the real daemons accept.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { afterAll } from 'vitest';
import fs from 'fs';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { startFakePdns } = await import('../../../helpers/fake-pdns.js');
const { ensureSecret } = await import('../../../../src/backends/shared/secret.js');
const { SECRET_DIR, API_KEY_FILE } = await import('../../../../src/backends/pdns/paths.js');
const { runBackendContract } = await import('../../../contract/backend-contract.js');

let tmpDir;
let pdns;
afterAll(async () => {
  await pdns?.close();
  delete process.env.PDNS_API_PORT;
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

runBackendContract('pdns', async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  enableIpv6(setup.db);
  pdns = await startFakePdns({ apiKey: ensureSecret(SECRET_DIR, API_KEY_FILE) });
  process.env.PDNS_API_PORT = String(pdns.port);
  const { createPdnsBackend } = await import('../../../../src/backends/pdns/index.js');
  return {
    backend: createPdnsBackend({
      exec: () => '',
      sysIfaces: () => ({}),
      ntpStatus: () => ({ available: true, synchronized: true }),
    }),
    db: setup.db,
  };
});
