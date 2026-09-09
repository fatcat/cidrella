import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../helpers/test-db.js';
import { regenerateScopeConfigs } from '../../src/utils/dhcp.js';

let db;
let tmpDir;
let confDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  confDir = path.join(tmpDir, 'generated-dhcp');
  fs.mkdirSync(confDir, { recursive: true });
});

afterAll(() => cleanupTestDb(tmpDir));

function createScope({ cidr, gateway, pools, leaseTime = '24h' }) {
  const parsed = cidr.split('/');
  const octets = parsed[0].split('.').map(Number);
  const prefix = Number(parsed[1]);
  const size = 2 ** (32 - prefix);
  const networkNumber = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
  const broadcastNumber = networkNumber + size - 1;
  const toIp = value => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
  const subnetId = db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, gateway_policy, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'allocated')
  `).run(
    cidr, cidr, parsed[0], toIp(broadcastNumber), prefix, size,
    gateway, gateway ? 'custom' : 'none'
  ).lastInsertRowid;
  const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const firstRange = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(subnetId, typeId, pools[0][0], pools[0][1]).lastInsertRowid;
  const scopeId = db.prepare(`
    INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time, enabled)
    VALUES (?, ?, ?, 1)
  `).run(subnetId, firstRange, leaseTime).lastInsertRowid;
  const insertPool = db.prepare(`
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertPool.run(scopeId, firstRange, pools[0][0], pools[0][1], 0);
  for (let index = 1; index < pools.length; index++) {
    const rangeId = db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, ?, ?)
    `).run(subnetId, typeId, pools[index][0], pools[index][1]).lastInsertRowid;
    insertPool.run(scopeId, rangeId, pools[index][0], pools[index][1], index);
  }
  return { subnetId, scopeId };
}

describe('canonical DHCP generated sink', () => {
  it('emits every configured interval, preserves holes, and excludes IP Reservations', () => {
    const { subnetId, scopeId } = createScope({
      cidr: '10.230.0.0/24',
      gateway: '10.230.0.254',
      pools: [['10.230.0.20', '10.230.0.61'], ['10.230.0.65', '10.230.0.240']],
      leaseTime: '12h'
    });
    db.prepare(`
      INSERT INTO ip_addresses (
        subnet_id, ip_address, allocation_state, allocation_source_type, reservation_note
      ) VALUES (?, '10.230.0.70', 'reserved', 'admin_reservation', 'hold')
    `).run(subnetId);

    expect(regenerateScopeConfigs(db, { confDir })).toBe(true);
    const content = fs.readFileSync(path.join(confDir, `dhcp-scope-${scopeId}.conf`), 'utf8');
    expect(content).toContain(`dhcp-range=set:scope${scopeId},10.230.0.20,10.230.0.61,255.255.255.0,12h`);
    expect(content).toContain(`dhcp-range=set:scope${scopeId},10.230.0.65,10.230.0.69,255.255.255.0,12h`);
    expect(content).toContain(`dhcp-range=set:scope${scopeId},10.230.0.71,10.230.0.240,255.255.255.0,12h`);
    expect(content).toContain(`dhcp-option=tag:scope${scopeId},3,10.230.0.254`);
    expect(content).not.toContain('10.230.0.62,10.230.0.64');
  });

  it('emits an empty router option for explicit gateway-none policy', () => {
    const { scopeId } = createScope({
      cidr: '10.231.0.0/24',
      gateway: null,
      pools: [['10.231.0.20', '10.231.0.200']]
    });
    regenerateScopeConfigs(db, { confDir });
    const content = fs.readFileSync(path.join(confDir, `dhcp-scope-${scopeId}.conf`), 'utf8');
    expect(content).toContain(`dhcp-option=tag:scope${scopeId},3\n`);
    expect(content).not.toMatch(new RegExp(`dhcp-option=tag:scope${scopeId},3,`));
  });

  it('removes stale scope files after a scope is disabled', () => {
    const { scopeId } = createScope({
      cidr: '10.232.0.0/24',
      gateway: '10.232.0.1',
      pools: [['10.232.0.20', '10.232.0.200']]
    });
    regenerateScopeConfigs(db, { confDir });
    const file = path.join(confDir, `dhcp-scope-${scopeId}.conf`);
    expect(fs.existsSync(file)).toBe(true);
    db.prepare('UPDATE dhcp_scopes SET enabled = 0 WHERE id = ?').run(scopeId);
    expect(regenerateScopeConfigs(db, { confDir })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});
