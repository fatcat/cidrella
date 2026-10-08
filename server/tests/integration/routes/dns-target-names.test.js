/**
 * Names as they are written elsewhere. A record's target name (CNAME, MX, SRV)
 * may be entered as a zone file writes it, with a trailing dot, and a
 * record's own name as the DNS table shows it, in full. Both are stored as
 * dnsmasq and the zone take them, on create and on update alike.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, enableIpv6, setupTestDb } from '../../helpers/test-db.js';
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
  enableIpv6(db);
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

describe('record names entered as the table shows them', () => {
  const storedName = (type) =>
    db.prepare('SELECT name FROM dns_records WHERE type = ?').get(type).name;

  it('stores the zone name as @ and a full name relative to the zone, either family', async () => {
    const cases = [
      [{ name: 'example.test', type: 'MX', value: 'mx.example.net', priority: 10 }, '@'],
      [{ name: 'EXAMPLE.TEST.', type: 'TXT', value: 'v=spf1 -all' }, '@'],
      [{ name: 'example.test', type: 'A', value: '203.0.113.9' }, '@'],
      [{ name: 'www.example.test', type: 'AAAA', value: '2001:db8::9' }, 'www'],
    ];
    for (const [body, expected] of cases) {
      expect((await create(body)).status).toBe(201);
      expect(storedName(body.type)).toBe(expected);
    }
  });

  it('takes an SRV by its full name, with or without the dot, on create and update', async () => {
    const srv = { type: 'SRV', value: 'sip.example.net', priority: 10, weight: 5, port: 5060 };
    const created = await create({ ...srv, name: '_sip._tcp.example.test' });
    expect(created.status).toBe(201);
    expect(storedName('SRV')).toBe('_sip._tcp');

    const updated = await request(app)
      .put(`/api/dns/zones/${zoneId}/records/${created.body.id}`)
      .send({ name: '_sips._tcp.example.test.' });
    expect(updated.status).toBe(200);
    expect(storedName('SRV')).toBe('_sips._tcp');

    // Outside the zone, or not _service._protocol, is still refused.
    expect((await create({ ...srv, name: '_sip._tcp.other.test' })).status).toBe(400);
    expect((await create({ ...srv, name: 'sip.example.test' })).status).toBe(400);
  });
});
