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
beforeEach(() => db.exec('DELETE FROM device_fingerprints; DELETE FROM device_fingerprint_changes;'));

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

describe('GET /api/devices/:mac/fingerprint/history', () => {
  it('reports device_type/os_family/vendor_class drift, newest first', async () => {
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', vendor_class: 'Samsung-TV', device_type: 'IoT', os_family: 'Tizen', confidence: 70, source: 'dhcp' });
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', vendor_class: 'generic-linux', device_type: 'Computer', os_family: 'Linux', confidence: 70, source: 'dhcp' });

    const res = await request(app).get('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint/history');
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.field).sort()).toEqual(['device_type', 'os_family', 'vendor_class']);
  });

  it('is empty for a device with no drift', async () => {
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', device_type: 'IoT', confidence: 60, source: 'dhcp' });
    const res = await request(app).get('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('400s on an invalid MAC', async () => {
    expect((await request(app).get('/api/devices/not-a-mac/fingerprint/history')).status).toBe(400);
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

describe('DELETE /api/devices/:mac/fingerprint', () => {
  it('clears a manual override and reports cleared:true', async () => {
    DF.setManual(db, 'aa:bb:cc:dd:ee:ff', { device_type: 'Printer', os_family: 'Linux' });
    const res = await request(app).delete('/api/devices/aa:bb:cc:dd:ee:ff/fingerprint');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: true });
    expect(DF.getByMac(db, 'aa:bb:cc:dd:ee:ff')).toBeNull();
  });

  it('is a no-op (cleared:false) for auto rows and unknown MACs', async () => {
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:aa', device_type: 'IoT', confidence: 60, source: 'dhcp' });
    const auto = await request(app).delete('/api/devices/aa:bb:cc:dd:ee:aa/fingerprint');
    expect(auto.status).toBe(200);
    expect(auto.body.cleared).toBe(false);
    expect(DF.getByMac(db, 'aa:bb:cc:dd:ee:aa')).not.toBeNull();

    const unknown = await request(app).delete('/api/devices/11:22:33:44:55:66/fingerprint');
    expect(unknown.status).toBe(200);
    expect(unknown.body.cleared).toBe(false);
  });

  it('400s on an invalid MAC', async () => {
    expect((await request(app).delete('/api/devices/nope/fingerprint')).status).toBe(400);
  });
});
