/**
 * POST /api/scans/probe: one address answers with its result; a list probes
 * every address of one network in a single targeted scan. The scanner is
 * mocked to record a result per target, so no packets leave the test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

const scanned = [];
vi.mock('../../../src/utils/scanner.js', async (importOriginal) => {
  const original = await importOriginal();
  const ScanRun = await import('../../../src/models/scan-run.js');
  return {
    ...original,
    startScan: vi.fn(async (db, scanId, _subnetId, { targetIps }) => {
      scanned.push(targetIps);
      for (const ip of targetIps) {
        ScanRun.insertResult(db, scanId, { ip, responded: ip.endsWith('.10') });
      }
      return { method: 'icmp' };
    }),
  };
});

const { default: scansRouter } = await import('../../../src/routes/scans.js');
const { default: request } = await import('supertest');
const { getDb } = await import('../../../src/db/init.js');

let tmpDir;
let app;
let subnetId;

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  app = createMultiRouterApp([{ prefix: '/api/scans', router: scansRouter }]);
  subnetId = getDb()
    .prepare(
      `INSERT INTO subnets (cidr, name, status, network_address, broadcast_address, prefix_length, total_addresses)
       VALUES ('10.60.0.0/24', 'probe', 'allocated', '10.60.0.0', '10.60.0.255', 24, 256)`,
    )
    .run().lastInsertRowid;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('POST /api/scans/probe', () => {
  it('probes one address and answers with its result', async () => {
    const res = await request(app).post('/api/scans/probe').send({ ip: '10.60.0.10' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ip: '10.60.0.10', responded: true, method: 'icmp' });
  });

  it('probes a list in one scan and leaves no scan behind', async () => {
    scanned.length = 0;
    const res = await request(app)
      .post('/api/scans/probe')
      .send({ subnet_id: subnetId, ips: ['10.60.0.10', '10.60.0.11', '10.60.0.10'] });
    expect(res.status).toBe(200);
    expect(scanned).toEqual([['10.60.0.10', '10.60.0.11']]);
    expect(res.body.results.map(({ ip, responded }) => [ip, responded])).toEqual([
      ['10.60.0.10', true],
      ['10.60.0.11', false],
    ]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM network_scans').get().n).toBe(0);
  });

  it('refuses a list without a network, outside it, or too long', async () => {
    const post = (body) => request(app).post('/api/scans/probe').send(body);
    expect((await post({ ips: ['10.60.0.1'] })).status).toBe(400);
    expect((await post({ subnet_id: subnetId, ips: [] })).status).toBe(400);
    expect((await post({ subnet_id: subnetId, ips: ['not-an-ip'] })).status).toBe(400);
    const outside = await post({ subnet_id: subnetId, ips: ['10.60.0.1', '10.61.0.1'] });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toContain('10.61.0.1');
    const many = Array.from({ length: 257 }, (_, i) => `10.60.${Math.floor(i / 256)}.${i % 256}`);
    expect((await post({ subnet_id: subnetId, ips: many })).status).toBe(400);
  });
});
