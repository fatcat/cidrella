/**
 * The DNS model every backend renders from: what is served and what is not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../../helpers/test-db.js';
import { seedBackendEstate } from '../../../helpers/backend-estate.js';
import { isPlaceholderPtr, loadDnsZones } from '../../../../src/backends/shared/dns-zone-model.js';

describe('isPlaceholderPtr', () => {
  it('flags bare addresses of either family', () => {
    expect(isPlaceholderPtr('10.60.0.12')).toBe(true);
    expect(isPlaceholderPtr('fd00:63::12')).toBe(true);
    expect(isPlaceholderPtr('nodots')).toBe(true);
  });

  it('passes host names, including ones that start with a digit', () => {
    expect(isPlaceholderPtr('web.golden.test')).toBe(false);
    expect(isPlaceholderPtr('3com.golden.test')).toBe(false);
  });
});

describe('loadDnsZones', () => {
  let db;
  let tmpDir;
  let model;

  beforeAll(async () => {
    ({ db, tmpDir } = await setupTestDb());
    enableIpv6(db);
    seedBackendEstate(db);
    const rev4 = db.prepare("SELECT id FROM dns_zones WHERE name LIKE '%in-addr.arpa'").get().id;
    const rev6 = db.prepare("SELECT id FROM dns_zones WHERE name LIKE '%ip6.arpa'").get().id;
    const add = db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled, source) VALUES (?, ?, 'PTR', ?, 1, 'manual')",
    );
    add.run(rev4, '13', '10.60.0.13');
    add.run(rev6, '3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', 'fd00:63::13');
    model = loadDnsZones(db);
  });
  afterAll(() => cleanupTestDb(tmpDir));

  const named = (fqdn, type) => model.records.filter((r) => r.fqdn === fqdn && r.type === type);

  it('leaves out disabled zones and their records', () => {
    expect(model.zones.map((z) => z.name)).not.toContain('off.test');
    expect(model.records.some((r) => r.zoneName === 'off.test')).toBe(false);
  });

  it('leaves out disabled records', () => {
    expect(named('off.golden.test', 'A')).toEqual([]);
  });

  it('gives every record its zone and FQDN, both families', () => {
    expect(named('web.golden.test', 'A')[0]).toMatchObject({
      value: '10.60.0.10',
      zoneName: 'golden.test',
      zoneType: 'forward',
    });
    expect(named('web.golden.test', 'AAAA')[0].value).toBe('fd00:63::10');
    expect(named('golden.test', 'MX')[0]).toMatchObject({ value: 'mail.golden.test', priority: 5 });
    expect(named('www.golden.test', 'CNAME')[0].ttl).toBe(300);
  });

  it('marks bare-address PTRs as placeholders, both families', () => {
    const ptrs = model.records.filter((r) => r.type === 'PTR');
    const byValue = Object.fromEntries(ptrs.map((r) => [r.value, r.placeholder]));
    expect(byValue['10.60.0.13']).toBe(true);
    expect(byValue['fd00:63::13']).toBe(true);
    expect(byValue['elsewhere.example.net']).toBe(false);
    const served = ptrs.filter((r) => !r.placeholder && r.value === 'web.golden.test');
    expect(served.map((r) => r.zoneName.endsWith('ip6.arpa'))).toEqual([false, true]);
  });

  it('keeps records in id order', () => {
    const ids = model.records.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
