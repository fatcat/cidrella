import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../src/db/init.js';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('canonical Network/DHCP migration', () => {
  it('normalizes legacy option 51 into scope lease policy without losing pools', async () => {
    const { db, tmpDir } = databaseThrough(66, { tmpDirs });
    const subnetId = db
      .prepare(
        `
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, gateway_address, gateway_policy
      ) VALUES ('10.240.0.0/24', 'migration', '10.240.0.0', '10.240.0.255',
        24, 256, 'allocated', '10.240.0.1', 'first')
    `,
      )
      .run().lastInsertRowid;
    const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const insertRange = db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, ?, ?)
    `);
    const explicitRange = insertRange.run(
      subnetId,
      typeId,
      '10.240.0.20',
      '10.240.0.80',
    ).lastInsertRowid;
    const inheritedRange = insertRange.run(
      subnetId,
      typeId,
      '10.240.0.100',
      '10.240.0.180',
    ).lastInsertRowid;
    const insertScope = db.prepare(`
      INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time) VALUES (?, ?, ?)
    `);
    const explicitScope = insertScope.run(subnetId, explicitRange, '24h').lastInsertRowid;
    const inheritedScope = insertScope.run(subnetId, inheritedRange, '8h').lastInsertRowid;
    const insertPool = db.prepare(`
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
      SELECT ?, id, start_ip, end_ip FROM ranges WHERE id = ?
    `);
    insertPool.run(explicitScope, explicitRange);
    insertPool.run(inheritedScope, inheritedRange);
    db.prepare(
      `
      INSERT INTO dhcp_scope_options (scope_id, option_code, value)
      VALUES (?, 51, '7200')
    `,
    ).run(explicitScope);
    db.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let upgraded;
    try {
      upgraded = await initDb(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(upgraded.prepare('SELECT id, lease_time FROM dhcp_scopes ORDER BY id').all()).toEqual([
      { id: explicitScope, lease_time: '7200s' },
      { id: inheritedScope, lease_time: '3600s' },
    ]);
    expect(
      upgraded
        .prepare('SELECT COUNT(*) AS count FROM dhcp_scope_options WHERE option_code = 51')
        .get().count,
    ).toBe(0);
    // The migration drops the legacy 51 default; startup then seeds the
    // shipped Lease Time default (3600) for new scopes.
    expect(
      upgraded
        .prepare(
          'SELECT value, enabled_by_default FROM dhcp_option_defaults WHERE option_code = 51',
        )
        .get(),
    ).toEqual({ value: '3600', enabled_by_default: 1 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM dhcp_scope_pools').get().count).toBe(2);
    expect(
      upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
    ).toBe(91);
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });
});
