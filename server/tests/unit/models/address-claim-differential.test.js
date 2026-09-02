/**
 * Differential test: the scanner path and the passive path must reach the same
 * "is this address claimed" verdict for the same row.
 *
 * `updateFromScan()` (scanner) and `recordPassiveActivity()` (DNS proxy) both
 * decide whether an address that answered is rogue. They used to answer that
 * with DIFFERENT sets of arms: the scanner honored `status IN ('locked',
 * 'assigned')` and `detection_source = 'dns'` and knew nothing about the
 * appliance's own addresses, while the passive path was the reverse. The
 * consequence was not cosmetic. `setStatus()` never clears `is_rogue`, and
 * `computeIpView` orders its rogue branch ahead of its locked branch, so an
 * address flagged rogue BEFORE an operator locked it rendered as ROGUE forever
 * on any subnet the scanner does not cover.
 *
 * Both now route through one `addressClaim()`. This test is what keeps them
 * there. See REVIEW.md, duplicate-logic audit #24 and #25.
 *
 * If this fails, do not fix it by special-casing one path. Fix addressClaim().
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';
import { resetLocalAddressCache } from '../../../src/utils/local-addresses.js';

let db;
let tmpDir;
let subnetId;

const SCAN_IP = '10.0.9.10';
const PASSIVE_IP = '10.0.9.11';

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  db.prepare(
    "INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status)"
    + " VALUES ('10.0.9.0/24', 'ClaimDiff', '10.0.9.0', '10.0.9.255', 24, 256, 'allocated')"
  ).run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.9.0/24'").get().id;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  resetLocalAddressCache();
});

// Seed the same starting row at two addresses, so each path gets its own copy
// and neither sees the other's writes.
//
// Every row starts ALREADY FLAGGED with the passive reason, deliberately. That
// is the one observable both paths share: the scanner writes
// `is_rogue = effectiveConflict ? 1 : 0` on every update, and the passive path
// clears a PASSIVE_ROGUE_REASON row when it considers the address claimed. So
// "ends at 0" means claimed on both and "stays 1" means unclaimed on both.
//
// Seeding is_rogue = 0 instead would make the whole suite vacuous: the passive
// path never SETS the flag on an existing row, it only ever clears one, so
// every case would trivially read 0 on that side.
function seedBoth(columns = {}) {
  for (const ip of [SCAN_IP, PASSIVE_IP]) {
    const cols = {
      status: 'available',
      is_rogue: 1,
      rogue_reason: IpAddress.PASSIVE_ROGUE_REASON,
      detection_source: null,
      ...columns,
    };
    db.prepare(
      'INSERT INTO ip_addresses (subnet_id, ip_address, status, is_rogue, rogue_reason, detection_source)'
      + ' VALUES (?, ?, ?, ?, ?, ?)'
    ).run(subnetId, ip, cols.status, cols.is_rogue, cols.rogue_reason, cols.detection_source);
  }
}

// MACs must differ per address: dhcp_reservations is UNIQUE(subnet_id, mac_address).
function macFor(ip, salt) {
  const last = ip.split('.')[3].padStart(2, '0').slice(-2);
  return `aa:bb:cc:dd:${salt}:${last}`;
}

function addLeaseAndReservationFor(ip, { lease = false, reservation = false } = {}) {
  if (lease) {
    db.prepare(
      "INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, expires_at) VALUES (?, ?, ?, 'infinite')"
    ).run(subnetId, ip, macFor(ip, 'e0'));
  }
  if (reservation) {
    db.prepare(
      'INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address) VALUES (?, ?, ?)'
    ).run(subnetId, ip, macFor(ip, 'f0'));
  }
}

function rogueAfterScan(ip) {
  IpAddress.updateFromScan(db, subnetId, ip, {
    responded: 1, mac: null, isConflict: 1, conflictReason: 'scan conflict',
  });
  return db.prepare('SELECT is_rogue FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
    .get(subnetId, ip)?.is_rogue;
}

function rogueAfterPassive(ip) {
  IpAddress.recordPassiveActivity(db, subnetId, ip, { createRogue: true });
  return db.prepare('SELECT is_rogue FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
    .get(subnetId, ip)?.is_rogue;
}

describe('scanner and passive paths agree on whether an address is claimed', () => {
  it('an operator-locked row is claimed by both (the bug that motivated this)', () => {
    // The exact reachable case: an address flagged rogue by the passive path,
    // which an operator then locks. setStatus() does not clear is_rogue, so the
    // flag is still set when the next sighting arrives. Before the fix the
    // scanner cleared it and the passive path did not, so on a subnet the
    // scanner does not cover the row stayed ROGUE forever.
    seedBoth({ status: 'locked' });
    const scan = rogueAfterScan(SCAN_IP);
    const passive = rogueAfterPassive(PASSIVE_IP);
    expect(scan).toBe(passive);
    expect(scan).toBe(0);
  });

  it('an assigned row is claimed by both', () => {
    seedBoth({ status: 'assigned' });
    expect(rogueAfterScan(SCAN_IP)).toBe(rogueAfterPassive(PASSIVE_IP));
  });

  it('a detection_source=dns row is claimed by both, even with no A record left', () => {
    seedBoth({ detection_source: 'dns' });
    expect(rogueAfterScan(SCAN_IP)).toBe(rogueAfterPassive(PASSIVE_IP));
  });

  it('an active lease claims the address on both paths', () => {
    seedBoth();
    addLeaseAndReservationFor(SCAN_IP, { lease: true });
    addLeaseAndReservationFor(PASSIVE_IP, { lease: true });
    expect(rogueAfterScan(SCAN_IP)).toBe(rogueAfterPassive(PASSIVE_IP));
  });

  it('a reservation claims the address on both paths', () => {
    seedBoth();
    addLeaseAndReservationFor(SCAN_IP, { reservation: true });
    addLeaseAndReservationFor(PASSIVE_IP, { reservation: true });
    expect(rogueAfterScan(SCAN_IP)).toBe(rogueAfterPassive(PASSIVE_IP));
  });

  it('an unclaimed row stays flagged on both, so the suite is not vacuous', () => {
    // Guards the guard. Without this, every case above would still pass if
    // addressClaim() started returning claimed for everything.
    seedBoth();
    const scan = rogueAfterScan(SCAN_IP);
    const passive = rogueAfterPassive(PASSIVE_IP);
    expect(scan).toBe(passive);
    expect(scan).toBe(1);
  });
});
