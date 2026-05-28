import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { DHCP_DEFAULT_NTP_SERVERS, FALLBACK_SECONDARY_DNS } from '../../../src/config/defaults.js';

const { default: operationsRouter } = await import('../../../src/routes/operations.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  app = createMultiRouterApp([
    { prefix: '/api/operations', router: operationsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/operations/reset-database', () => {
  it('reseeds DHCP option defaults shown by Settings - DHCP', async () => {
    const reset = await request(app).post('/api/operations/reset-database').send({});
    expect(reset.status).toBe(200);

    const res = await request(app).get('/api/dhcp/options');
    expect(res.status).toBe(200);

    const enabled = new Set(res.body.enabledDefaults);
    for (const code of [1, 3, 6, 15, 42, 51, 119]) {
      expect(enabled.has(code), `option ${code} should be enabled by default`).toBe(true);
    }

    expect(res.body.defaults[42]).toBe(DHCP_DEFAULT_NTP_SERVERS);
    expect(res.body.defaults[51]).toBe('3600');
    expect(res.body.defaults[6]).toContain(FALLBACK_SECONDARY_DNS);
    expect(res.body.defaults[6]).toMatch(/^(\d{1,3}\.){3}\d{1,3},9\.9\.9\.9$/);
  });
});
