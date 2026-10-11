/**
 * While a server stack switch runs, the switch owns the listen config: the
 * interface settings answer 409 and change nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));
vi.mock('../../../src/utils/dns-proxy.js', () => ({ rebindProxy: vi.fn() }));

const { default: request } = await import('supertest');
const { setSwitchInProgress } = await import('../../../src/utils/switch-state.js');

let tmpDir;
let db;
let app;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const interfaces = await import('../../../src/routes/interfaces.js');
  app = createMultiRouterApp([{ prefix: '/api/interfaces', router: interfaces.default }]);
});
afterAll(() => {
  setSwitchInProgress(false);
  cleanupTestDb(tmpDir);
});

describe('PUT /api/interfaces/config during a stack switch', () => {
  it('answers 409 and leaves the settings alone', async () => {
    const before = db.prepare("SELECT value FROM settings WHERE key = 'dns_enabled'").get();
    setSwitchInProgress(true);
    const res = await request(app).put('/api/interfaces/config').send({ dns_enabled: false });
    setSwitchInProgress(false);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A server switch is running; try again when it is done');
    expect(db.prepare("SELECT value FROM settings WHERE key = 'dns_enabled'").get()).toEqual(
      before,
    );
  });
});
