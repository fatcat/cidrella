/**
 * /api/backend-stack: admin only, validates the stack, maps a switch's
 * outcome to a status and an audit entry. The switch itself is tested in
 * tests/integration/backends/stack-switch.test.js; here it is stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../../src/services/stack-switch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  switchStack: vi.fn(),
  switchPreflight: vi.fn((target) => ({
    current: 'dnsmasq',
    target,
    stacks: [{ name: 'dnsmasq' }, { name: 'pdns-kea' }],
    blocked: null,
    gained: [],
    lost: [],
  })),
}));

const { default: request } = await import('supertest');
const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const switchModule = await import('../../../src/services/stack-switch.js');
const { SwitchError } = switchModule;

let db;
let tmpDir;
let app;
let role;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const { default: router } = await import('../../../src/routes/backend-stack.js');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 1, role, username: 'tester' };
    next();
  });
  app.use('/api/backend-stack', router);
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  role = 'admin';
  switchModule.switchStack.mockReset();
  db.prepare('DELETE FROM audit_log').run();
});

const lastAudit = () =>
  db.prepare('SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 1').get();

describe('GET /api/backend-stack', () => {
  it('shows the stack serving, both stacks, and what switching would do', async () => {
    const res = await request(app).get('/api/backend-stack');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current: 'dnsmasq', label: 'dnsmasq', switching: false });
    expect(res.body.stacks.map((s) => s.name)).toEqual(['dnsmasq', 'pdns-kea']);
    expect(res.body.targets).toEqual([
      { name: 'pdns-kea', label: 'PowerDNS + Kea', blocked: null, gained: [], lost: [] },
    ]);
  });

  it('is for admins only', async () => {
    role = 'dhcp_admin';
    expect((await request(app).get('/api/backend-stack')).status).toBe(403);
  });
});

describe('POST /api/backend-stack', () => {
  it('switches and audits what moved', async () => {
    switchModule.switchStack.mockResolvedValue({
      from: 'dnsmasq',
      to: 'pdns-kea',
      leases: 4,
      added: 4,
      failed: [],
      missing: [],
      snapshot: '/data/handover/x.json',
    });
    const res = await request(app).post('/api/backend-stack').send({ stack: 'pdns-kea' });
    expect(res.status).toBe(200);
    expect(res.body.leases).toBe(4);
    expect(lastAudit().action).toBe('backend_stack_switched');
    expect(JSON.parse(lastAudit().details)).toEqual({
      from: 'dnsmasq',
      to: 'pdns-kea',
      leases: 4,
      refused: 0,
      missing: 0,
    });
  });

  it('refuses an unknown stack before anything runs', async () => {
    const res = await request(app).post('/api/backend-stack').send({ stack: 'kea' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('stack must be one of: dnsmasq, pdns-kea');
    expect(switchModule.switchStack).not.toHaveBeenCalled();
  });

  it('answers 409 when the preflight refuses', async () => {
    switchModule.switchStack.mockRejectedValue(
      new SwitchError('preflight', 'radvd is not installed'),
    );
    const res = await request(app).post('/api/backend-stack').send({ stack: 'pdns-kea' });
    expect(res).toMatchObject({ status: 409, body: { error: 'radvd is not installed' } });
    expect(lastAudit()).toBeUndefined();
  });

  it('says where a switch stopped and that the old stack is back', async () => {
    switchModule.switchStack.mockRejectedValue(
      new SwitchError('start', 'kea-dhcp4 could not open its sockets', { rolledBack: true }),
    );
    const res = await request(app).post('/api/backend-stack').send({ stack: 'pdns-kea' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error:
        'The switch to PowerDNS + Kea stopped (start): kea-dhcp4 could not open its sockets. ' +
        'dnsmasq serves DNS and DHCP again.',
      phase: 'start',
      rolledBack: true,
    });
    expect(lastAudit().action).toBe('backend_stack_switch_failed');
  });

  it('is for admins only', async () => {
    role = 'dhcp_admin';
    const res = await request(app).post('/api/backend-stack').send({ stack: 'pdns-kea' });
    expect(res.status).toBe(403);
    expect(switchModule.switchStack).not.toHaveBeenCalled();
  });
});
