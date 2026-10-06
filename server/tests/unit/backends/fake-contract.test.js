/**
 * The fake backend tests use must keep the same contract as a real one, or
 * tests written against it stop meaning anything.
 */
import { afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createFakeBackend } from '../../helpers/fake-backends.js';
import { runBackendContract } from '../../contract/backend-contract.js';

let tmpDir;
afterAll(() => cleanupTestDb(tmpDir));

runBackendContract('fake', async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  const backend = createFakeBackend();
  return { backend, db: setup.db, seedLeases: (leases) => backend.seedLeases(leases) };
});
