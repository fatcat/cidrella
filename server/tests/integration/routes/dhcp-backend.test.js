/**
 * /api/dhcp/server: admin only, validates the target, maps a switch's
 * outcome to a status and an audit entry. The switch itself is tested in
 * tests/integration/backends/dhcp-switch.test.js; here it is stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../../src/services/dhcp-backend-switch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  switchDhcpBackend: vi.fn(),
  switchPreflight: vi.fn((target) => ({ target, blocked: null, gained: [], lost: [] })),
}));

const { default: request } = await import('supertest');
const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const switchModule = await import('../../../src/services/dhcp-backend-switch.js');
const { SwitchError } = switchModule;

let db;
let tmpDir;
let app;
let role;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const { default: router } = await import('../../../src/routes/dhcp-backend.js');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 1, role, username: 'tester' };
    next();
  });
  app.use('/api/dhcp/server', router);
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  role = 'admin';
  switchModule.switchDhcpBackend.mockReset();
  db.prepare('DELETE FROM audit_log').run();
});

const lastAudit = () =>
  db.prepare('SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 1').get();

describe('GET /api/dhcp/server', () => {
  it('shows the current server and what switching to the other would do', async () => {
    const res = await request(app).get('/api/dhcp/server');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current: 'dnsmasq', label: 'dnsmasq', switching: false });
    expect(res.body.targets).toEqual([
      { name: 'kea', label: 'Kea', target: 'kea', blocked: null, gained: [], lost: [] },
    ]);
  });

  it('is for admins only', async () => {
    role = 'dhcp_admin';
    expect((await request(app).get('/api/dhcp/server')).status).toBe(403);
  });
});

describe('POST /api/dhcp/server', () => {
  it('switches and audits what moved', async () => {
    switchModule.switchDhcpBackend.mockResolvedValue({
      from: 'dnsmasq',
      to: 'kea',
      leases: 4,
      added: 4,
      failed: [],
      missing: [],
      snapshot: '/data/handover/x.json',
    });
    const res = await request(app).post('/api/dhcp/server').send({ target: 'kea' });
    expect(res.status).toBe(200);
    expect(res.body.leases).toBe(4);
    expect(lastAudit().action).toBe('dhcp_backend_switched');
    expect(JSON.parse(lastAudit().details)).toEqual({
      from: 'dnsmasq',
      to: 'kea',
      leases: 4,
      refused: 0,
      missing: 0,
    });
  });

  it('refuses an unknown target before anything runs', async () => {
    const res = await request(app).post('/api/dhcp/server').send({ target: 'isc-dhcpd' });
    expect(res.status).toBe(400);
    expect(switchModule.switchDhcpBackend).not.toHaveBeenCalled();
  });

  it('answers 409 when the preflight refuses', async () => {
    switchModule.switchDhcpBackend.mockRejectedValue(
      new SwitchError('preflight', 'Kea is not installed'),
    );
    const res = await request(app).post('/api/dhcp/server').send({ target: 'kea' });
    expect(res).toMatchObject({ status: 409, body: { error: 'Kea is not installed' } });
    expect(lastAudit()).toBeUndefined();
  });

  it('says where a switch stopped and that the old server is back', async () => {
    switchModule.switchDhcpBackend.mockRejectedValue(
      new SwitchError('serve', 'kea-dhcp4 could not open its sockets', { rolledBack: true }),
    );
    const res = await request(app).post('/api/dhcp/server').send({ target: 'kea' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error:
        'The switch to Kea stopped (serve): kea-dhcp4 could not open its sockets. dnsmasq serves DHCP again.',
      phase: 'serve',
      rolledBack: true,
    });
    expect(lastAudit().action).toBe('dhcp_backend_switch_failed');
  });

  it('is for admins only', async () => {
    role = 'dhcp_admin';
    const res = await request(app).post('/api/dhcp/server').send({ target: 'kea' });
    expect(res.status).toBe(403);
    expect(switchModule.switchDhcpBackend).not.toHaveBeenCalled();
  });
});
