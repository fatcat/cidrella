import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status)
    VALUES ('10.0.9.0/24', 'ClaimDiff', '10.0.9.0', '10.0.9.255', 24, 256, 'allocated')
  `).run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.9.0/24'").get().id;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
});

describe('canonical address claims', () => {
  it('re-checks canonical allocation when scan input was built from stale data', () => {
    IpAddress.upsert(db, subnetId, '10.0.9.10', { allocation_state: 'reserved' });

    IpAddress.updateFromScan(db, subnetId, '10.0.9.10', {
      responded: 1,
      mac: null,
      isConflict: 1,
      conflictReason: 'stale scan map'
    });

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.9.10')).toMatchObject({
      allocation_state: 'reserved',
      is_rogue: 0,
      rogue_reason: null
    });
  });

  it('does not infer a claim from a raw active lease', () => {
    db.prepare(`
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, expires_at)
      VALUES (?, '10.0.9.11', 'aa:bb:cc:dd:ee:11', 'infinite')
    `).run(subnetId);

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.9.11', { createRogue: true });

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.9.11')).toMatchObject({
      allocation_state: 'unassigned',
      is_rogue: 1
    });
  });

  it('does not infer a claim from a raw reservation', () => {
    db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address)
      VALUES (?, '10.0.9.12', 'aa:bb:cc:dd:ee:12')
    `).run(subnetId);

    IpAddress.updateFromScan(db, subnetId, '10.0.9.12', {
      responded: 1,
      mac: 'aa:bb:cc:dd:ee:12',
      isConflict: 1,
      conflictReason: 'missing canonical transition'
    });

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.9.12')).toMatchObject({
      allocation_state: 'unassigned',
      is_rogue: 1
    });
  });
});
