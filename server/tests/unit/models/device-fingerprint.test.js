import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { getDb } from '../../../src/db/init.js';
import * as DF from '../../../src/models/device-fingerprint.js';

let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => getDb().exec('DELETE FROM device_fingerprints;'));

describe('device-fingerprint model', () => {
  it('upserts and looks up in a batch (Map by mac)', () => {
    const db = getDb();
    DF.upsertFingerprint(db, { mac_address: 'AA:BB:CC:DD:EE:FF', dhcp_fingerprint: '1,3,6,15', device_type: 'Computer', os_family: 'Windows', confidence: 80, source: 'dhcp' });
    const map = DF.lookupFingerprintBatch(db, ['aa:bb:cc:dd:ee:ff', 'no:su:ch:ma:c0:00']);
    expect(map.get('aa:bb:cc:dd:ee:ff')).toMatchObject({ device_type: 'Computer', os_family: 'Windows', confidence: 80 });
    expect(map.has('no:su:ch:ma:c0:00')).toBe(false);
  });

  it('returns an empty map fast when the table is empty', () => {
    expect(DF.lookupFingerprintBatch(getDb(), ['aa:bb:cc:dd:ee:ff']).size).toBe(0);
  });

  it('re-capture refreshes signals + bumps last_seen but does not lower a manual override', () => {
    const db = getDb();
    DF.setManual(db, 'aa:bb:cc:dd:ee:ff', { device_type: 'Printer', os_family: 'Linux' });
    // a later dhcp capture should NOT overwrite the manual type/os
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:ff', dhcp_fingerprint: '1,3,6', device_type: 'Computer', os_family: 'Windows', confidence: 80, source: 'dhcp' });
    const row = DF.getByMac(db, 'aa:bb:cc:dd:ee:ff');
    expect(row.source).toBe('manual');
    expect(row.device_type).toBe('Printer');
    expect(row.os_family).toBe('Linux');
    expect(row.confidence).toBe(100);
    // but raw dhcp signal is still refreshed
    expect(row.dhcp_fingerprint).toBe('1,3,6');
  });

  it('getByMac is case-insensitive and returns null for unknown', () => {
    const db = getDb();
    DF.upsertFingerprint(db, { mac_address: '11:22:33:44:55:66', device_type: 'IoT', confidence: 60 });
    expect(DF.getByMac(db, '11:22:33:44:55:66').device_type).toBe('IoT');
    expect(DF.getByMac(db, 'ff:ff:ff:ff:ff:ff')).toBeNull();
  });

  it('clearManual removes a manual override so the next capture re-classifies', () => {
    const db = getDb();
    DF.setManual(db, 'aa:bb:cc:dd:ee:01', { device_type: 'Printer', os_family: 'Linux' });
    expect(DF.getByMac(db, 'aa:bb:cc:dd:ee:01').source).toBe('manual');

    const info = DF.clearManual(db, 'AA:BB:CC:DD:EE:01');
    expect(info.changes).toBe(1);
    expect(DF.getByMac(db, 'aa:bb:cc:dd:ee:01')).toBeNull();

    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:01', dhcp_fingerprint: '1,3,6', device_type: 'Computer', os_family: 'Windows', confidence: 80, source: 'dhcp' });
    const row = DF.getByMac(db, 'aa:bb:cc:dd:ee:01');
    expect(row.source).toBe('dhcp');
    expect(row.device_type).toBe('Computer');
  });

  it('clearManual is a no-op on auto-classified rows', () => {
    const db = getDb();
    DF.upsertFingerprint(db, { mac_address: 'aa:bb:cc:dd:ee:02', device_type: 'IoT', confidence: 60, source: 'dhcp' });
    const info = DF.clearManual(db, 'aa:bb:cc:dd:ee:02');
    expect(info.changes).toBe(0);
    expect(DF.getByMac(db, 'aa:bb:cc:dd:ee:02').device_type).toBe('IoT');
  });
});

