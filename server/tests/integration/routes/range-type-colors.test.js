/**
 * Network Range Type colors: the colors the address grid reserves for a
 * status are refused, and an edit to a type's name or color shows on every
 * address in its ranges at the next read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyDhcp',
    'applyResolver',
  ]),
);
vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyInterfaceConfig: vi.fn(),
  regenerateDnsmasqConf: vi.fn(),
  signalDnsmasq: vi.fn(),
  restartDnsmasq: vi.fn(),
}));

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: rangeRouter } = await import('../../../src/routes/ranges.js');
const { default: rangeTypeRouter } = await import('../../../src/routes/range-types.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  tmpDir = (await setupTestDb()).tmpDir;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter },
    { prefix: '/api/range-types', router: rangeTypeRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

describe('range type colors', () => {
  it('refuses a status color and a near neighbor, on create and on edit', async () => {
    const rogue = await request(app)
      .post('/api/range-types')
      .send({ name: 'Red', color: '#ef4444' });
    expect(rogue.status).toBe(400);
    expect(rogue.body.error).toMatch(/rogue hosts/);

    const near = await request(app)
      .post('/api/range-types')
      .send({ name: 'Orange', color: '#f97316' });
    expect(near.status).toBe(400);

    const ok = await request(app).post('/api/range-types').send({ name: 'Pink', color: '#ec4899' });
    expect(ok.status).toBe(201);

    const edit = await request(app)
      .put(`/api/range-types/${ok.body.id}`)
      .send({ color: '#3b82f6' });
    expect(edit.status).toBe(400);
    expect(edit.body.error).toMatch(/in the address grid/);
  });

  it('lets a type that already holds a refused color be renamed', async () => {
    const { getDb } = await import('../../../src/db/init.js');
    const id = Number(
      getDb()
        .prepare("INSERT INTO range_types (name, color, is_system) VALUES ('Legacy', '#f97316', 0)")
        .run().lastInsertRowid,
    );
    const renamed = await request(app)
      .put(`/api/range-types/${id}`)
      .send({ name: 'Legacy 2', color: '#f97316' });
    expect(renamed.status).toBe(200);
  });

  it('carries a type edit to every address in its ranges', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.120.0.0/24', name: 'color-prop' });
    expect(created.status).toBe(201);
    const subnetId = created.body.id;
    await request(app)
      .post(`/api/subnets/${subnetId}/configure`)
      .send({ name: 'color-prop', create_reverse_dns: false, create_dhcp_scope: false });

    const type = await request(app)
      .post('/api/range-types')
      .send({ name: 'Lab', color: '#84cc16' });
    const set = await request(app)
      .put(`/api/subnets/${subnetId}/ranges/set-type`)
      .send({
        range_type_id: type.body.id,
        ranges: [{ start_ip: '10.120.0.10', end_ip: '10.120.0.20' }],
      });
    expect(set.status).toBe(200);

    const read = async () => {
      const res = await request(app).get(`/api/subnets/${subnetId}/ips?page=1&pageSize=64`);
      return res.body.ips.filter((row) => row.network_range_type);
    };
    const before = await read();
    expect(before).toHaveLength(11);
    expect(before.every((r) => r.network_range_type === 'Lab')).toBe(true);

    const edit = await request(app)
      .put(`/api/range-types/${type.body.id}`)
      .send({ name: 'Lab bench', color: '#0ea5e9' });
    expect(edit.status).toBe(200);

    const after = await read();
    expect(after).toHaveLength(11);
    expect(
      after.every(
        (r) => r.network_range_type === 'Lab bench' && r.network_range_type_color === '#0ea5e9',
      ),
    ).toBe(true);
  });

  it('clears a type from part of a range and keeps the rest of it', async () => {
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: '10.121.0.0/24', name: 'clear-type' });
    const subnetId = created.body.id;
    await request(app)
      .post(`/api/subnets/${subnetId}/configure`)
      .send({ name: 'clear-type', create_reverse_dns: false, create_dhcp_scope: false });
    const type = await request(app)
      .post('/api/range-types')
      .send({ name: 'Bench', color: '#ec4899' });
    await request(app)
      .put(`/api/subnets/${subnetId}/ranges/set-type`)
      .send({
        range_type_id: type.body.id,
        ranges: [{ start_ip: '10.121.0.10', end_ip: '10.121.0.20' }],
      });

    const cleared = await request(app)
      .put(`/api/subnets/${subnetId}/ranges/clear-type`)
      .send({ ranges: [{ start_ip: '10.121.0.12', end_ip: '10.121.0.14' }] });
    expect(cleared.status).toBe(200);

    const res = await request(app).get(`/api/subnets/${subnetId}/ips?page=1&pageSize=64`);
    const typed = res.body.ips
      .filter((row) => row.network_range_type === 'Bench')
      .map((row) => row.ip_address)
      .sort();
    expect(typed).toEqual(
      [
        '10.121.0.10',
        '10.121.0.11',
        ...[15, 16, 17, 18, 19, 20].map((n) => `10.121.0.${n}`),
      ].sort(),
    );

    const none = await request(app).put(`/api/subnets/${subnetId}/ranges/clear-type`).send({});
    expect(none.status).toBe(400);
  });
});
