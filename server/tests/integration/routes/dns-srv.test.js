import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal()),
);
vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: request } = await import('supertest');

let app;
let tmpDir;

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  app = createTestApp(dnsRouter, '/api/dns');
});

afterAll(() => cleanupTestDb(tmpDir));

// DNSMASQ-04: an SRV name is stored as `_service._protocol` and must read as
// a name under its zone, not as an absolute two-label name.
describe('SRV records', () => {
  it('lists an SRV record with its zone in the FQDN', async () => {
    const zone = await request(app)
      .post('/api/dns/zones')
      .send({ name: 'srv.example.lan', type: 'forward' });
    expect(zone.status).toBe(201);

    const created = await request(app).post(`/api/dns/zones/${zone.body.id}/records`).send({
      name: '_sip._tcp',
      type: 'SRV',
      value: 'pbx.srv.example.lan',
      port: 5060,
      priority: 10,
      weight: 5,
    });
    expect(created.status).toBe(201);

    const list = await request(app).get(`/api/dns/zones/${zone.body.id}/records`);
    const srv = list.body.find((r) => r.type === 'SRV');
    expect(srv.name).toBe('_sip._tcp');
    expect(srv.record_fqdn).toBe('_sip._tcp.srv.example.lan');
  });

  it('refuses an SRV name that carries its zone, so stored names stay relative', async () => {
    const zone = await request(app)
      .post('/api/dns/zones')
      .send({ name: 'srv2.example.lan', type: 'forward' });
    const res = await request(app).post(`/api/dns/zones/${zone.body.id}/records`).send({
      name: '_sip._tcp.srv2.example.lan',
      type: 'SRV',
      value: 'pbx.srv2.example.lan',
      port: 5060,
    });
    expect(res.status).toBe(400);
  });
});
