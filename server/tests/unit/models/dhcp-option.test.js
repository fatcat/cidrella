import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DhcpOption from '../../../src/models/dhcp-option.js';

let db;
let tmpDir;

function createSubnetAndScope() {
  const subnetId = db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, status
    )
    VALUES ('10.70.0.0/24', 'options-test', '10.70.0.0', '10.70.0.255', 24, 256, '10.70.0.1', 'allocated')
  `).run().lastInsertRowid;
  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, '10.70.0.20', '10.70.0.200')
  `).run(subnetId, rangeTypeId).lastInsertRowid;
  return db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, dns_servers, domain_name)
    VALUES (?, ?, '24h', '10.70.0.1', '["10.70.0.8"]', 'legacy.test')
  `).run(rangeId, subnetId).lastInsertRowid;
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
  db.prepare('DELETE FROM dhcp_option_defaults').run();
  db.prepare('DELETE FROM dhcp_custom_options').run();
  db.prepare('DELETE FROM dhcp_scopes').run();
  db.prepare('DELETE FROM ranges').run();
  db.prepare('DELETE FROM subnets').run();
});

describe('DHCP option ownership', () => {
  it('creates and deletes custom options with dependent defaults and scope values', () => {
    const scopeId = createSubnetAndScope();
    const custom = DhcpOption.createCustomOption(db, {
      code: 150,
      name: 'custom-150',
      label: 'TFTP',
      type: 'ip',
      description: 'boot'
    });
    db.prepare('INSERT INTO dhcp_option_defaults (option_code, value) VALUES (150, ?)').run('10.70.0.10');
    db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, 150, ?)').run(scopeId, '10.70.0.11');

    DhcpOption.deleteCustomOption(db, { code: 150 });

    expect(custom.id).toBeGreaterThan(0);
    expect(db.prepare('SELECT * FROM dhcp_custom_options WHERE code = 150').get()).toBeUndefined();
    expect(db.prepare('SELECT * FROM dhcp_option_defaults WHERE option_code = 150').get()).toBeUndefined();
    expect(db.prepare('SELECT * FROM dhcp_scope_options WHERE option_code = 150').get()).toBeUndefined();
  });

  it('replaces global defaults and preserves enabled-only defaults', () => {
    const result = DhcpOption.replaceDefaultOptions(db, [
      { code: 6, value: '10.70.0.8' }
    ], [6, 119]);

    expect(result.defaults).toEqual({ 6: '10.70.0.8' });
    expect(result.enabledDefaults.sort((a, b) => a - b)).toEqual([6, 119]);
  });

  it('migrates legacy scope columns and removes inherited gateway duplicates', () => {
    const scopeId = createSubnetAndScope();

    const migrated = DhcpOption.migrateLegacyScopeOptions(db);
    const migratedRows = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ? ORDER BY option_code')
      .all(scopeId);
    const cleaned = DhcpOption.cleanupRedundantGatewayOptions(db);

    expect(migrated).toBe(1);
    expect(migratedRows).toEqual([
      { option_code: 3, value: '10.70.0.1' },
      { option_code: 6, value: '10.70.0.8' },
      { option_code: 15, value: 'legacy.test' }
    ]);
    expect(cleaned).toBe(1);
    expect(db.prepare('SELECT * FROM dhcp_scope_options WHERE scope_id = ? AND option_code = 3').get(scopeId))
      .toBeUndefined();
  });
});
