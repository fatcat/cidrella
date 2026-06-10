import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

const { default: deviceRouter } = await import('../../../src/routes/devices.js');
const DF = await import('../../../src/models/device-fingerprint.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(deviceRouter, '/api/devices');
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => db.exec('DELETE FROM device_fingerprints;'));

describe('GET /api/devices/:mac/fingerprint', () => {
  it('returns a stored fingerprint', async () => {
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', dhcp_fingerprint: '1,3,6', vendor_class: 'MSFT 5.0', device_type: 'Computer', os_family: 'Windows', confidence: 85, source: 'dhcp' });
    const res = await request(app).get('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ os_family: 'Windows', device_type: 'Computer', confidence: 85, vendor_class: 'MSFT 5.0' });
  });

  it('returns null-ish fields for an unknown (but valid) MAC', async () => {
    const res = await request(app).get('/api/devices/11:22:33:44:55:66/fingerprint');
    expect(res.status).toBe(200);
    expect(res.body.os_family).toBeNull();
    expect(res.body.device_type).toBeNull();
  });

  it('400s on an invalid MAC', async () => {
    expect((await request(app).get('/api/devices/not-a-mac/fingerprint')).status).toBe(400);
  });
});

describe('PUT /api/devices/:mac/fingerprint (override)', () => {
  it('sets a manual override that a later dhcp capture cannot clobber', async () => {
    const put = await request(app).put('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint').send({ device_type: 'Printer', os_family: 'Linux' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ device_type: 'Printer', os_family: 'Linux', source: 'manual', confidence: 100 });

    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', device_type: 'Computer', os_family: 'Windows', confidence: 80, source: 'dhcp' });
    const after = await request(app).get('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint');
    expect(after.body).toMatchObject({ device_type: 'Printer', os_family: 'Linux', source: 'manual' });
  });

  it('rejects an over-long device_type', async () => {
    const res = await request(app).put('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint').send({ device_type: 'x'.repeat(100) });
    expect(res.status).toBe(400);
  });
});
