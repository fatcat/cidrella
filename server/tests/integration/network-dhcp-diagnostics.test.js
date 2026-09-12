import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../helpers/test-db.js';
import { getNetworkDhcpDiagnostics } from '../../src/utils/network-dhcp-diagnostics.js';
import { repairDerivedNetworkDhcpState } from '../../src/services/subnet-topology.js';

let db;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('network/DHCP migration inventory and safe repair', () => {
  it('reports and repairs derived topology and router inconsistencies', () => {
    const subnetId = db
      .prepare(
        `
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, gateway_policy, status
      ) VALUES ('10.210.0.0/29', 'repair', '10.210.0.0', '10.210.0.7', 29, 8,
        '10.210.0.6', 'last', 'allocated')
    `,
      )
      .run().lastInsertRowid;
    db.prepare(
      `
      INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state)
      VALUES (?, '10.210.0.6', 'unassigned')
    `,
    ).run(subnetId);
    const type = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    const rangeId = db
      .prepare(
        `
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, '10.210.0.1', '10.210.0.5')
    `,
      )
      .run(subnetId, type.id).lastInsertRowid;
    const scopeId = db
      .prepare(
        `
      INSERT INTO dhcp_scopes (range_id, subnet_id, gateway) VALUES (?, ?, '10.210.0.1')
    `,
      )
      .run(rangeId, subnetId).lastInsertRowid;
    db.prepare(
      `
      INSERT INTO dhcp_scope_options (scope_id, option_code, value)
      VALUES (?, 3, '10.210.0.1')
    `,
    ).run(scopeId);
    db.prepare(`UPDATE subnets SET broadcast_address = '10.210.0.99' WHERE id = ?`).run(subnetId);

    const before = getNetworkDhcpDiagnostics(db);
    expect(before.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'network_derivative_mismatch',
        'topology_ip_mismatch',
        'stale_router_option',
      ]),
    );
    expect(repairDerivedNetworkDhcpState(db)).toEqual({ subnets_reconciled: 1, scopes_rebased: 1 });
    const after = getNetworkDhcpDiagnostics(db);
    expect(after.issues).toEqual([]);
  });

  it('reports ambiguous overlapping pools and lease ownership without repairing them', () => {
    const subnetId = db
      .prepare(
        `
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, gateway_policy, status
      ) VALUES ('10.211.0.0/24', 'ambiguous', '10.211.0.0', '10.211.0.255',
        24, 256, '10.211.0.1', 'first', 'allocated')
    `,
      )
      .run().lastInsertRowid;
    const type = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    const insertRange = db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, ?, ?)
    `);
    const insertScope = db.prepare(`
      INSERT INTO dhcp_scopes (range_id, subnet_id) VALUES (?, ?)
    `);
    const insertPool = db.prepare(`
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip) VALUES (?, ?, ?, ?)
    `);
    for (const [start, end] of [
      ['10.211.0.20', '10.211.0.100'],
      ['10.211.0.80', '10.211.0.160'],
    ]) {
      const rangeId = insertRange.run(subnetId, type.id, start, end).lastInsertRowid;
      const scopeId = insertScope.run(rangeId, subnetId).lastInsertRowid;
      insertPool.run(scopeId, rangeId, start, end);
    }
    db.prepare(
      `
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, expires_at)
      VALUES (?, '10.212.0.40', '02:00:00:02:12:40', 'infinite')
    `,
    ).run(subnetId);

    const report = getNetworkDhcpDiagnostics(db);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'overlapping_enabled_pools', safe_repair: false }),
        expect.objectContaining({ code: 'lease_owner_mismatch', safe_repair: false }),
      ]),
    );
  });
});
