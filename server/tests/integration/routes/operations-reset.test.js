import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { DHCP_DEFAULT_NTP_SERVERS } from '../../../src/config/defaults.js';
import { FALLBACK_SECONDARY_DNS } from '../../../src/utils/dhcp-network-options.js';

const { default: operationsRouter } = await import('../../../src/routes/operations.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
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
    for (const code of [1, 3, 6, 15, 42, 119]) {
      expect(enabled.has(code), `option ${code} should be enabled by default`).toBe(true);
    }
    expect(enabled.has(51)).toBe(false);

    expect(res.body.defaults[42]).toBe(DHCP_DEFAULT_NTP_SERVERS);
    expect(res.body.defaults[51]).toBeUndefined();
    expect(res.body.defaults[6]).toContain(FALLBACK_SECONDARY_DNS);
    expect(res.body.defaults[6]).toMatch(/^(\d{1,3}\.){3}\d{1,3},9\.9\.9\.9$/);
  });
});

describe('the audit row of a reset', () => {
  it('leaves the reset as the only entry, naming who asked', async () => {
    db.prepare(
      "INSERT INTO audit_log (action, entity_type, actor) VALUES ('vlan_created', 'vlan', 'x')",
    ).run();
    expect((await request(app).post('/api/operations/reset-database').send({})).status).toBe(200);
    const rows = db.prepare('SELECT action, actor, user_id, details FROM audit_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'database_reset', actor: 'testadmin', user_id: null });
    expect(JSON.parse(rows[0].details).removed).toHaveProperty('subnets');
  });
});
