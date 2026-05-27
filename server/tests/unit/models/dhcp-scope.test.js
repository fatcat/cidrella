import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DhcpScope from '../../../src/models/dhcp-scope.js';

let db;
let tmpDir;

function createSubnet() {
  return db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, status, domain_name
    )
    VALUES ('10.50.0.0/24', 'scope-test', '10.50.0.0', '10.50.0.255', 24, 256, '10.50.0.1', 'allocated', 'scope.test')
  `).run().lastInsertRowid;
}

function createRange(subnetId, startIp = '10.50.0.50', endIp = '10.50.0.150') {
  const rangeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
  return db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(subnetId, rangeType.id, startIp, endIp).lastInsertRowid;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM dhcp_scope_options').run();
  db.prepare('DELETE FROM dhcp_scopes').run();
  db.prepare('DELETE FROM ranges').run();
  db.prepare('DELETE FROM subnets').run();
});

describe('DHCP scope ownership', () => {
  it('creates scopes and skips option values inherited from the subnet', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);

    const scope = DhcpScope.createScope(db, {
      range_id: rangeId,
      subnet_id: subnetId,
      options: [
        { code: 3, value: '10.50.0.1' },
        { code: 6, value: '10.50.0.8' }
      ]
    }, { subnet, defaultLeaseTime: '24h' });

    expect(scope.lease_time).toBe('24h');
    expect(scope.options).toEqual([{ option_code: 6, value: '10.50.0.8' }]);
  });

  it('updates scope fields, range bounds, and replaces explicit options', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(db, {
      range_id: rangeId,
      subnet_id: subnetId,
      options: [{ code: 6, value: '10.50.0.8' }]
    }, { subnet, defaultLeaseTime: '24h' });

    const updated = DhcpScope.updateScope(db, scope, {
      lease_time: '12h',
      start_ip: '10.50.0.60',
      end_ip: '10.50.0.140',
      options: [{ code: 15, value: 'custom.scope.test' }]
    }, { subnet });

    expect(updated.lease_time).toBe('12h');
    expect(updated.start_ip).toBe('10.50.0.60');
    expect(updated.end_ip).toBe('10.50.0.140');
    expect(updated.options).toEqual([{ option_code: 15, value: 'custom.scope.test' }]);
  });

  it('deletes a scope, its explicit options, and its backing range', () => {
    const subnetId = createSubnet();
    const rangeId = createRange(subnetId);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const scope = DhcpScope.createScope(db, {
      range_id: rangeId,
      subnet_id: subnetId,
      options: [{ code: 6, value: '10.50.0.8' }]
    }, { subnet, defaultLeaseTime: '24h' });

    DhcpScope.deleteScope(db, scope);

    expect(db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(scope.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM dhcp_scope_options WHERE scope_id = ?').get(scope.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM ranges WHERE id = ?').get(rangeId)).toBeUndefined();
  });
});
