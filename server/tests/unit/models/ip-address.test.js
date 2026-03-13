import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;

  // Create a leaf subnet to attach IPs to
  db.prepare("INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status) VALUES ('10.0.1.0/24', 'Test', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated')").run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.1.0/24'").get().id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM scan_results').run();
  db.prepare('DELETE FROM network_scans').run();
});

// ── upsert ──────────────────────────────────────────────

describe('upsert', () => {
  it('inserts a new IP with defaults', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.10', { hostname: 'web1' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.10');

    expect(row).toBeTruthy();
    expect(row.hostname).toBe('web1');
    expect(row.status).toBe('available');
    expect(row.is_rogue).toBe(0);
  });

  it('sets first_seen_at on insert when there is activity', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.11', { is_online: 1 });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.11');

    expect(row.first_seen_at).toBeTruthy();
    expect(row.last_seen_at).toBeTruthy();
  });

  it('does not set first_seen_at on insert without activity', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.12', { hostname: 'dns-only' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.12');

    expect(row.first_seen_at).toBeNull();
  });

  it('updates existing row without overwriting first_seen_at', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.13', { is_online: 1 });
    const first = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.13');

    // Update with new hostname — first_seen_at should be preserved
    IpAddress.upsert(db, subnetId, '10.0.1.13', { hostname: 'updated' });
    const second = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.13');

    expect(second.hostname).toBe('updated');
    expect(second.first_seen_at).toBe(first.first_seen_at);
  });

  it('skips no-op updates', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.14', { hostname: 'same', status: 'assigned' });
    const first = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.14');

    // Same values — updated_at should not change
    IpAddress.upsert(db, subnetId, '10.0.1.14', { hostname: 'same', status: 'assigned' });
    const second = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.14');

    expect(second.updated_at).toBe(first.updated_at);
  });

  it('sets detection_source', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.15', { detection_source: 'dns' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.15');

    expect(row.detection_source).toBe('dns');
  });

  it('returns the row id', () => {
    const id = IpAddress.upsert(db, subnetId, '10.0.1.16', {});
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    // Second call returns same id
    const id2 = IpAddress.upsert(db, subnetId, '10.0.1.16', { hostname: 'x' });
    expect(id2).toBe(id);
  });
});

// ── markOnline / markOffline ────────────────────────────

describe('markOnline', () => {
  it('sets is_online, last_seen_at, first_seen_at on existing row', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.20', {});
    IpAddress.markOnline(db, subnetId, '10.0.1.20', { source: 'passive' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.20');

    expect(row.is_online).toBe(1);
    expect(row.last_seen_at).toBeTruthy();
    expect(row.first_seen_at).toBeTruthy();
    expect(row.detection_source).toBe('passive');
  });

  it('does not create new rows', () => {
    const result = IpAddress.markOnline(db, subnetId, '10.0.1.99', {});
    expect(result.changes).toBe(0);
  });

  it('sets last_seen_mac when provided', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.21', {});
    IpAddress.markOnline(db, subnetId, '10.0.1.21', { mac: 'aa:bb:cc:dd:ee:ff' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.21');

    expect(row.last_seen_mac).toBe('aa:bb:cc:dd:ee:ff');
  });
});

describe('markOffline', () => {
  it('clears is_online and rogue status', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.22', { is_online: 1, is_rogue: 1, rogue_reason: 'test' });
    IpAddress.markOffline(db, subnetId, '10.0.1.22');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.22');

    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });
});

// ── bulkMarkStale ───────────────────────────────────────

describe('bulkMarkStale', () => {
  it('marks stale IPs offline and clears rogue', () => {
    // Insert an IP that was last seen 2 hours ago
    IpAddress.upsert(db, subnetId, '10.0.1.30', { is_online: 1, is_rogue: 1, rogue_reason: 'rogue' });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.30'")
      .run(subnetId);

    // Insert an IP seen just now
    IpAddress.upsert(db, subnetId, '10.0.1.31', { is_online: 1 });

    IpAddress.bulkMarkStale(db, 60); // 60 minutes stale threshold

    const stale = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30');
    const fresh = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31');

    expect(stale.is_online).toBe(0);
    expect(stale.is_rogue).toBe(0);
    expect(stale.rogue_reason).toBeNull();

    expect(fresh.is_online).toBe(1);
  });
});

// ── setRogue / clearRogue / clearRogueForSubnet ─────────

describe('rogue management', () => {
  it('setRogue marks an IP as rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.40', {});
    IpAddress.setRogue(db, subnetId, '10.0.1.40', 'MAC mismatch');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.40');

    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe('MAC mismatch');
  });

  it('clearRogue clears rogue on a single IP', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.41', { is_rogue: 1, rogue_reason: 'test' });
    IpAddress.clearRogue(db, subnetId, '10.0.1.41');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.41');

    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('clearRogueForSubnet clears all except listed IPs', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.42', { is_rogue: 1, rogue_reason: 'a' });
    IpAddress.upsert(db, subnetId, '10.0.1.43', { is_rogue: 1, rogue_reason: 'b' });
    IpAddress.upsert(db, subnetId, '10.0.1.44', { is_rogue: 1, rogue_reason: 'c' });

    // Keep .43 as rogue, clear the rest
    IpAddress.clearRogueForSubnet(db, subnetId, new Set(['10.0.1.43']));

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.42').is_rogue).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.43').is_rogue).toBe(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.44').is_rogue).toBe(0);
  });

  it('clearRogueForSubnet with empty set clears all', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.45', { is_rogue: 1, rogue_reason: 'x' });
    IpAddress.upsert(db, subnetId, '10.0.1.46', { is_rogue: 1, rogue_reason: 'y' });

    IpAddress.clearRogueForSubnet(db, subnetId);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.45').is_rogue).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.46').is_rogue).toBe(0);
  });
});

// ── updateFromScan ──────────────────────────────────────

describe('updateFromScan', () => {
  it('updates existing IP with scan results', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.50', { status: 'assigned', mac_address: 'aa:bb:cc:dd:ee:01' });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.50', {
      responded: 1, mac: 'aa:bb:cc:dd:ee:01', isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.50');
    expect(row.is_online).toBe(1);
    expect(row.last_scanned_at).toBeTruthy();
    expect(row.first_seen_at).toBeTruthy();
    expect(row.detection_source).toBe('scanner');
    expect(row.is_rogue).toBe(0);
    // Existing mac_address should not be overwritten
    expect(row.mac_address).toBe('aa:bb:cc:dd:ee:01');
  });

  it('marks existing IP as rogue on conflict', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.51', {});

    IpAddress.updateFromScan(db, subnetId, '10.0.1.51', {
      responded: 1, mac: 'ff:ff:ff:ff:ff:ff', isConflict: 1, conflictReason: 'Rogue device'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.51');
    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe('Rogue device');
  });

  it('sets is_online=0 when IP did not respond', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.52', { is_online: 1 });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.52', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.52');
    expect(row.is_online).toBe(0);
  });

  it('creates new row for responding rogue with no existing record', () => {
    IpAddress.updateFromScan(db, subnetId, '10.0.1.53', {
      responded: 1, mac: 'de:ad:be:ef:00:01', isConflict: 1, conflictReason: 'Rogue device (IP not assigned)'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.53');
    expect(row).toBeTruthy();
    expect(row.status).toBe('available');
    expect(row.is_online).toBe(1);
    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe('Rogue device (IP not assigned)');
    expect(row.mac_address).toBe('de:ad:be:ef:00:01');
    expect(row.first_seen_at).toBeTruthy();
    expect(row.detection_source).toBe('scanner');
  });

  it('does nothing for non-responding IP with no existing record', () => {
    IpAddress.updateFromScan(db, subnetId, '10.0.1.54', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.54');
    expect(row).toBeUndefined();
  });

  it('fills mac_address only when empty', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.55', { mac_address: 'aa:aa:aa:aa:aa:aa' });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.55', {
      responded: 1, mac: 'bb:bb:bb:bb:bb:bb', isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.55');
    // mac_address should NOT be overwritten
    expect(row.mac_address).toBe('aa:aa:aa:aa:aa:aa');
    // but last_seen_mac should be set
    expect(row.last_seen_mac).toBe('bb:bb:bb:bb:bb:bb');
  });
});

// ── setStatus ───────────────────────────────────────────

describe('setStatus', () => {
  it('creates new IP with status and note', () => {
    IpAddress.setStatus(db, subnetId, '10.0.1.60', 'locked', 'Reserved for gateway');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.60');

    expect(row.status).toBe('locked');
    expect(row.reservation_note).toBe('Reserved for gateway');
    expect(row.detection_source).toBe('manual');
  });

  it('updates existing IP status', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.61', { status: 'available' });
    IpAddress.setStatus(db, subnetId, '10.0.1.61', 'locked', 'test');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.61');

    expect(row.status).toBe('locked');
    expect(row.reservation_note).toBe('test');
  });
});

// ── setScanEnabled ──────────────────────────────────────

describe('setScanEnabled', () => {
  it('creates IP with scan_enabled override', () => {
    IpAddress.setScanEnabled(db, subnetId, '10.0.1.70', 0);
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.70');

    expect(row.scan_enabled).toBe(0);
    expect(row.status).toBe('available');
  });

  it('updates scan_enabled on existing row', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.71', {});
    IpAddress.setScanEnabled(db, subnetId, '10.0.1.71', 1);
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.71');

    expect(row.scan_enabled).toBe(1);
  });
});

// ── pruneOldScanResults ─────────────────────────────────

describe('pruneOldScanResults', () => {
  it('deletes scan_results from old completed scans', () => {
    // Create two completed scans
    db.prepare("INSERT INTO network_scans (subnet_id, status, total_ips, completed_at) VALUES (?, 'completed', 10, datetime('now', '-1 hour'))").run(subnetId);
    const oldScanId = db.prepare("SELECT last_insert_rowid() as id").get().id;

    db.prepare("INSERT INTO network_scans (subnet_id, status, total_ips, completed_at) VALUES (?, 'completed', 10, datetime('now'))").run(subnetId);
    const newScanId = db.prepare("SELECT last_insert_rowid() as id").get().id;

    // Insert results for both scans
    db.prepare("INSERT INTO scan_results (scan_id, ip_address, responded) VALUES (?, '10.0.1.1', 1)").run(oldScanId);
    db.prepare("INSERT INTO scan_results (scan_id, ip_address, responded) VALUES (?, '10.0.1.1', 1)").run(newScanId);

    IpAddress.pruneOldScanResults(db, subnetId, newScanId);

    const oldResults = db.prepare('SELECT COUNT(*) as c FROM scan_results WHERE scan_id = ?').get(oldScanId);
    const newResults = db.prepare('SELECT COUNT(*) as c FROM scan_results WHERE scan_id = ?').get(newScanId);

    expect(oldResults.c).toBe(0);
    expect(newResults.c).toBe(1);
  });
});

// ── lifecycle: rogue cleared on offline ─────────────────

describe('rogue device goes offline', () => {
  it('bulkMarkStale clears rogue when device becomes stale', () => {
    // Simulate: rogue device detected by scan, then goes silent
    IpAddress.upsert(db, subnetId, '10.0.1.80', {
      is_online: 1, is_rogue: 1, rogue_reason: 'Rogue device (IP not assigned)',
      detection_source: 'scanner'
    });

    // Backdate last_seen_at to 2 hours ago
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.80'")
      .run(subnetId);

    // Staleness sweep with 60-minute threshold
    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.80');
    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('markOffline clears rogue on explicit offline', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.81', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.81');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.81');
    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });
});
