/**
 * A record's target name (CNAME, MX, SRV) may be entered as a zone file
 * writes it, with a trailing dot. It is stored without one, as dnsmasq takes
 * it, on create and on update alike.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    restartDnsmasq: vi.fn(),
    signalDnsmasq: vi.fn(),
  };
});

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: request } = await import('supertest');

let app;
let db;
let tmpDir;
let zoneId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = createMultiRouterApp([{ prefix: '/api/dns', router: dnsRouter }]);
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  zoneId = Number(
    db
      .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)")
      .run().lastInsertRowid,
  );
});

const create = (body) => request(app).post(`/api/dns/zones/${zoneId}/records`).send(body);

describe('target names with a trailing dot', () => {
  it('stores an MX target without the dot', async () => {
    const res = await create({ name: '@', type: 'MX', value: 'ASPMX.l.google.com.', priority: 10 });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT value FROM dns_records WHERE type = ?').get('MX').value).toBe(
      'aspmx.l.google.com',
    );
  });

  it('stores an SRV target without the dot', async () => {
    const res = await create({
      name: '_sip._tcp',
      type: 'SRV',
      value: 'sip.example.net.',
      priority: 10,
      weight: 5,
      port: 5060,
    });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT value FROM dns_records WHERE type = ?').get('SRV').value).toBe(
      'sip.example.net',
    );
  });

  it('takes the dot on an update too, and still refuses a name that is not one', async () => {
    const created = await create({ name: '@', type: 'MX', value: 'mx1.example.net', priority: 10 });
    const id = created.body.id ?? created.body.record?.id;
    const updated = await request(app)
      .put(`/api/dns/zones/${zoneId}/records/${id}`)
      .send({ value: 'mx2.example.net.' });
    expect(updated.status).toBe(200);
    expect(db.prepare('SELECT value FROM dns_records WHERE id = ?').get(id).value).toBe(
      'mx2.example.net',
    );
    expect(
      (await create({ name: '@', type: 'MX', value: 'not a host.', priority: 10 })).status,
    ).toBe(400);
  });
});
