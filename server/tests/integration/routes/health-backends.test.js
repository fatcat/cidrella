import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule({
    name: 'fakedns',
    capabilities: { 'rec-dnssec-validate': true },
  }),
);

const { default: healthRouter } = await import('../../../src/routes/health.js');
const { backend } = await import('../../../src/backends/index.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  app = createTestApp(healthRouter, '/api/health');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/health/system backends', () => {
  it('reports each role by backend name, without the 0.5.1 dnsmasq field', async () => {
    const res = await request(app).get('/api/health/system');
    expect(res.status).toBe(200);
    expect(res.body.backends.dns).toMatchObject({
      name: 'fakedns',
      running: true,
      restartPending: false,
    });
    expect(res.body.backends.dhcp).toEqual(res.body.backends.dns);
    expect(res.body.backends.ra).toEqual(res.body.backends.dns);
    expect(res.body).not.toHaveProperty('services');
    expect(res.body.backends.dns.features['rec-dnssec-validate']).toBe(true);
    expect(res.body.dnssec.supported).toBe(true);
  });

  it('reports a stopped backend', async () => {
    const status = backend.status;
    backend.status = () => ({ name: 'fakedns', running: false, restartPending: true });
    try {
      const res = await request(app).get('/api/health/system');
      expect(res.body.backends.dns.running).toBe(false);
      expect(res.body.backends.dns.restartPending).toBe(true);
    } finally {
      backend.status = status;
    }
  });
});
