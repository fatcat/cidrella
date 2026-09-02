import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateConfigs: vi.fn(), generateReverseNames: original.generateReverseNames };
});
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn() };
});

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: request } = await import('supertest');

/**
 * Duplicate-logic audit #23.
 *
 * An address with a manual A record but no ip_addresses row gets SYNTHESIZED by
 * GET /api/subnets/:id/ips. That placeholder used to hardcode has_static_dns: 0,
 * and enrichIpViewRows treats anything other than `undefined` as "already
 * computed, do not touch", so the row came back as plain available. The same
 * address seen through the DHCP scope route came back as static-DNS, because
 * that builder omits the field and lets enrichment fill it.
 */
let tmpDir, app, db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(subnetRouter, '/api/subnets');
});
afterAll(() => cleanupTestDb(tmpDir));

describe('#23: a synthesized row still reflects a manual A record', () => {
  it('marks an unpersisted address that has a static A record', async () => {
    const created = await request(app).post('/api/subnets').send({
      cidr: '10.77.0.0/24', name: 'audit23', domain_name: 'audit.lan', status: 'allocated'
    });
    expect(created.status).toBe(201);
    const subnetId = created.body.id;

    const zoneId = db.prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('audit.lan','forward',1)"
    ).run().lastInsertRowid;
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'synthetic', 'A', '10.77.0.99', 1)"
    ).run(zoneId);

    // The route must SYNTHESIZE .99. If a persisted row exists this tests the
    // wrong code path entirely, so assert the precondition rather than assume.
    db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ? AND ip_address IN (?, ?)')
      .run(subnetId, '10.77.0.99', '10.77.0.98');
    const persisted = db.prepare(
      'SELECT COUNT(*) FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
    ).pluck().get(subnetId, '10.77.0.99');
    expect(persisted, 'fixture must leave .99 unpersisted or this tests nothing').toBe(0);

    const res = await request(app).get(`/api/subnets/${subnetId}/ips`).query({ pageSize: 512 });
    expect(res.status).toBe(200);

    const row = res.body.ips.find(r => r.ip_address === '10.77.0.99');
    expect(row, 'synthesized row should be present').toBeTruthy();
    expect(row.has_static_dns).toBe(1);

    // A neighbour with no record must NOT be swept up, otherwise the assertion
    // above would also pass with the flag hardcoded to 1.
    const plain = res.body.ips.find(r => r.ip_address === '10.77.0.98');
    expect(plain, 'neighbour row should be present').toBeTruthy();
    expect(plain.has_static_dns).toBe(0);
  });
});
