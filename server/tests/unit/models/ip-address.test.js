import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as IpAddress from '../../../src/models/ip-address.js';
import { resetLocalAddressCache } from '../../../src/utils/local-addresses.js';

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
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
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

    // Update with new hostname, first_seen_at should be preserved
    IpAddress.upsert(db, subnetId, '10.0.1.13', { hostname: 'updated' });
    const second = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.13');

    expect(second.hostname).toBe('updated');
    expect(second.first_seen_at).toBe(first.first_seen_at);
  });

  it('skips no-op updates', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.14', { hostname: 'same', status: 'assigned' });
    const first = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.14');

    // Same values, updated_at should not change
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

describe('recordPassiveActivity', () => {
  it('marks existing rows online through the model', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.25', {});
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.25', { source: 'passive' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.25');

    expect(row.is_online).toBe(1);
    expect(row.last_seen_at).toBeTruthy();
    expect(row.detection_source).toBe('passive');
  });

  it('does not create unknown rows unless requested', () => {
    const result = IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.26');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.26');

    expect(result.changes).toBe(0);
    expect(row).toBeUndefined();
  });

  it('creates unknown passive rows as rogue when requested', () => {
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.27', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.27');

    expect(row.is_online).toBe(1);
    expect(row.is_rogue).toBe(1);
    expect(row.status).toBe('available');
    expect(row.rogue_reason).toBe('passive DNS query from unassigned address');
  });
});

// Regression: an address named by a manual A record is one the operator declared
// in use. The scanner always honoured that; this path did not, so any host with a
// DNS name was flagged rogue the moment it sent its first query through the proxy.
describe('recordPassiveActivity: addresses named in DNS are not rogue', () => {
  function addForwardARecord(ip, name = 'pve-01', zoneName = 'example.test', source = 'manual') {
    const zoneId = db.prepare('INSERT INTO dns_zones (name, type, enabled) VALUES (?, ?, 1)')
      .run(zoneName, 'forward').lastInsertRowid;
    db.prepare('INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(zoneId, name, 'A', ip, source);
    return zoneId;
  }

  it('creates the row online and named, not rogue, when DNS claims the address', () => {
    addForwardARecord('10.0.1.30');
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.30', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30');

    expect(row.is_online).toBe(1);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
    expect(row.hostname).toBe('pve-01.example.test');
  });

  it('creates the row even when createRogue is off, so liveness is not lost', () => {
    addForwardARecord('10.0.1.31', 'nas');
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.31', { createRogue: false });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31');

    expect(row).toBeTruthy();
    expect(row.is_online).toBe(1);
    expect(row.is_rogue).toBe(0);
  });

  it('clears a stale rogue flag left behind by the old behaviour', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.32', {
      is_online: 1,
      is_rogue: 1,
      rogue_reason: IpAddress.PASSIVE_ROGUE_REASON,
    });
    addForwardARecord('10.0.1.32', 'printer');

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.32', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.32');

    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
    expect(row.hostname).toBe('printer.example.test');
  });

  it('leaves a MAC-mismatch rogue alone, a DNS name does not excuse a conflict', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.33', {
      is_online: 1,
      is_rogue: 1,
      rogue_reason: 'MAC mismatch (expected aa:bb:cc:dd:ee:ff, got 11:22:33:44:55:66)',
    });
    addForwardARecord('10.0.1.33', 'squatted');

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.33', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.33');

    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toContain('MAC mismatch');
  });

  it('still flags an address no DNS record claims', () => {
    addForwardARecord('10.0.1.34', 'elsewhere');   // a record, but for a different IP
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.35', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.35');

    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe(IpAddress.PASSIVE_ROGUE_REASON);
  });

  it('ignores DHCP-sourced A records, those track a lease not an operator decision', () => {
    addForwardARecord('10.0.1.36', 'leased', 'example.test', 'dhcp');
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.36', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.36');

    expect(row.is_rogue).toBe(1);
  });

  it('ignores A records in a disabled zone', () => {
    const zoneId = addForwardARecord('10.0.1.37', 'offzone');
    db.prepare('UPDATE dns_zones SET enabled = 0 WHERE id = ?').run(zoneId);

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.37', { createRogue: true });
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.37').is_rogue).toBe(1);
  });

  it('backfills the hostname so the offline sweep keeps the row', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.38', { is_online: 1 });
    addForwardARecord('10.0.1.38', 'keepme');
    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.38', { createRogue: true });

    // Without the hostname, shouldKeepOffline() deletes the row and the next
    // query recreates it, which is the flap that made these come and go.
    IpAddress.markOffline(db, subnetId, '10.0.1.38');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.38');

    expect(row).toBeTruthy();
    expect(row.hostname).toBe('keepme.example.test');
  });
});

describe('markOffline', () => {
  it('deletes ephemeral IPs (no hostname, not locked/assigned, no reservation)', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.22', { is_online: 1, is_rogue: 1, rogue_reason: 'test' });
    IpAddress.markOffline(db, subnetId, '10.0.1.22');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.22');

    expect(row).toBeUndefined();
  });

  it('keeps persistent IPs (with hostname) and clears rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.23', { is_online: 1, is_rogue: 1, rogue_reason: 'test', hostname: 'server1' });
    IpAddress.markOffline(db, subnetId, '10.0.1.23');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.23');

    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('keeps DHCP rows offline even without a hostname', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.24', {
      status: 'dhcp',
      mac_address: 'aa:bb:cc:dd:ee:24',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.24');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.24');
    expect(row).toBeTruthy();
    expect(row.is_online).toBe(0);
    expect(row.status).toBe('dhcp');
  });
});

// ── bulkMarkStale ───────────────────────────────────────

describe('bulkMarkStale', () => {
  it('deletes stale ephemeral IPs', () => {
    // Ephemeral IP last seen 2 hours ago, should be deleted
    IpAddress.upsert(db, subnetId, '10.0.1.30', {
      is_online: 1,
      is_rogue: 1,
      rogue_reason: 'rogue',
      detection_source: 'passive'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.30'")
      .run(subnetId);

    // Fresh IP, should remain online
    IpAddress.upsert(db, subnetId, '10.0.1.31', { is_online: 1, detection_source: 'passive' });

    IpAddress.bulkMarkStale(db, 60);

    const stale = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30');
    const fresh = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31');

    expect(stale).toBeUndefined();
    expect(fresh.is_online).toBe(1);
  });

  it('keeps stale persistent IPs and clears rogue', () => {
    // Persistent IP (has hostname) last seen 2 hours ago, should be kept but marked offline
    IpAddress.upsert(db, subnetId, '10.0.1.32', {
      is_online: 1,
      is_rogue: 1,
      rogue_reason: 'rogue',
      hostname: 'db-server',
      detection_source: 'passive'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.32'")
      .run(subnetId);

    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.32');

    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
    expect(row.hostname).toBe('db-server');
  });

  it('marks stale DHCP rows offline when the scanner does not cover them', () => {
    // Holding a lease is not evidence the host is up, and with no scan interval
    // configured nothing else will ever disprove it.
    IpAddress.upsert(db, subnetId, '10.0.1.33', {
      status: 'dhcp',
      mac_address: 'aa:bb:cc:dd:ee:33',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.33'")
      .run(subnetId);

    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.33');
    expect(row).toBeTruthy();
    expect(row.is_online).toBe(0);
    // The MAC survives the sweep. Ageing it out is the retention window's call.
    expect(row.mac_address).toBe('aa:bb:cc:dd:ee:33');
  });

  it('leaves stale rows alone on a subnet the scanner covers', () => {
    // The scanner sets both edges from the probe result. Sweeping here too
    // would flap a responding host offline between scans.
    db.prepare('UPDATE subnets SET scan_interval = ? WHERE id = ?').run('30m', subnetId);
    try {
      IpAddress.upsert(db, subnetId, '10.0.1.34', {
        status: 'dhcp',
        mac_address: 'aa:bb:cc:dd:ee:34',
        is_online: 1,
        detection_source: 'dhcp_lease'
      });
      db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.34'")
        .run(subnetId);

      IpAddress.bulkMarkStale(db, 60);

      const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.34');
      expect(row.is_online).toBe(1);
    } finally {
      db.prepare('UPDATE subnets SET scan_interval = NULL WHERE id = ?').run(subnetId);
    }
  });

  it('leaves stale rows alone when a per-IP scan override keeps them scanned', () => {
    db.prepare('UPDATE subnets SET scan_interval = ? WHERE id = ?').run('30m', subnetId);
    try {
      IpAddress.upsert(db, subnetId, '10.0.1.35', { is_online: 1 });
      db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours'), scan_enabled = 1 WHERE subnet_id = ? AND ip_address = '10.0.1.35'")
        .run(subnetId);

      IpAddress.bulkMarkStale(db, 60);

      expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.35').is_online).toBe(1);
    } finally {
      db.prepare('UPDATE subnets SET scan_interval = NULL WHERE id = ?').run(subnetId);
    }
  });

  it('sweeps a row the subnet scans but a per-IP override excludes', () => {
    db.prepare('UPDATE subnets SET scan_interval = ? WHERE id = ?').run('30m', subnetId);
    try {
      IpAddress.upsert(db, subnetId, '10.0.1.36', {
        is_online: 1, mac_address: 'aa:bb:cc:dd:ee:36'
      });
      db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours'), scan_enabled = 0 WHERE subnet_id = ? AND ip_address = '10.0.1.36'")
        .run(subnetId);

      IpAddress.bulkMarkStale(db, 60);

      expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.36').is_online).toBe(0);
    } finally {
      db.prepare('UPDATE subnets SET scan_interval = NULL WHERE id = ?').run(subnetId);
    }
  });
});

describe('upsert liveness events', () => {
  function typesFor(ip) {
    const row = IpAddress.findBySubnetAndIp(db, subnetId, ip);
    return db.prepare('SELECT event_type FROM ip_events WHERE ip_address_id = ? ORDER BY id')
      .all(row.id).map(e => e.event_type);
  }

  it('emits online and offline on the edges only', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.60', { mac_address: 'aa:bb:cc:dd:ee:60' });
    IpAddress.upsert(db, subnetId, '10.0.1.60', { is_online: 1 });
    IpAddress.upsert(db, subnetId, '10.0.1.60', { is_online: 1 });
    IpAddress.upsert(db, subnetId, '10.0.1.60', { is_online: 0 });
    IpAddress.upsert(db, subnetId, '10.0.1.60', { is_online: 0 });

    expect(typesFor('10.0.1.60').filter(t => t === 'online' || t === 'offline'))
      .toEqual(['online', 'offline']);
  });

  it('emits nothing when is_online is not part of the write', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.61', { mac_address: 'aa:bb:cc:dd:ee:61' });
    IpAddress.upsert(db, subnetId, '10.0.1.61', { is_online: 1 });
    IpAddress.upsert(db, subnetId, '10.0.1.61', { hostname: 'renamed' });

    expect(typesFor('10.0.1.61').filter(t => t === 'online' || t === 'offline'))
      .toEqual(['online']);
  });
});

// ── isAdminDeclared / clearStaleDynamicMetadata ─────────

describe('isAdminDeclared', () => {
  function addForwardARecord(ip, name = 'declared', zoneName = 'declared.test', source = 'manual') {
    const zoneId = db.prepare('INSERT INTO dns_zones (name, type, enabled) VALUES (?, ?, 1)')
      .run(zoneName, 'forward').lastInsertRowid;
    db.prepare('INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(zoneId, name, 'A', ip, source);
  }

  it('is true for a manual A record', () => {
    addForwardARecord('10.0.1.40');
    const row = { subnet_id: subnetId, ip_address: '10.0.1.40', status: 'available' };
    expect(IpAddress.isAdminDeclared(db, row)).toBe(true);
  });

  it('is false for a DHCP-synced A record, which is an observation not a declaration', () => {
    addForwardARecord('10.0.1.41', 'synced', 'synced.test', 'dhcp');
    const row = { subnet_id: subnetId, ip_address: '10.0.1.41', status: 'available' };
    expect(IpAddress.isAdminDeclared(db, row)).toBe(false);
  });

  it('is true for an enabled DHCP reservation and false for a disabled one', () => {
    db.prepare(`INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
                VALUES (?, '10.0.1.42', 'aa:bb:cc:dd:ee:42', 'kept', 1)`).run(subnetId);
    db.prepare(`INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
                VALUES (?, '10.0.1.43', 'aa:bb:cc:dd:ee:43', 'off', 0)`).run(subnetId);

    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.42', status: 'dhcp' })).toBe(true);
    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.43', status: 'dhcp' })).toBe(false);
  });

  it('is true for locked and assigned, false for a plain dynamic lease row', () => {
    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.44', status: 'locked' })).toBe(true);
    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.45', status: 'assigned' })).toBe(true);
    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.46', status: 'dhcp' })).toBe(false);
  });

  it('does not treat an active lease as a declaration', () => {
    db.prepare(`INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
                VALUES (?, '10.0.1.47', 'aa:bb:cc:dd:ee:47', 'leased', 'infinite')`).run(subnetId);
    expect(IpAddress.isAdminDeclared(db, { subnet_id: subnetId, ip_address: '10.0.1.47', status: 'dhcp' })).toBe(false);
  });
});

describe('clearStaleDynamicMetadata', () => {
  function seedOffline(ip, fields = {}) {
    IpAddress.upsert(db, subnetId, ip, { is_online: 1, ...fields });
    db.prepare(`UPDATE ip_addresses SET is_online = 0, last_seen_at = datetime('now', '-30 days')
                 WHERE subnet_id = ? AND ip_address = ?`).run(subnetId, ip);
  }

  it('deletes a long-offline dynamic row outright', () => {
    seedOffline('10.0.1.50', {
      hostname: 'old-laptop', mac_address: 'aa:bb:cc:dd:ee:50',
      status: 'dhcp', detection_source: 'dhcp_lease'
    });

    IpAddress.clearStaleDynamicMetadata(db);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.50')).toBeUndefined();
  });

  it('clears learned fields but keeps a row carrying operator text', () => {
    seedOffline('10.0.1.51', {
      hostname: 'old-phone', mac_address: 'aa:bb:cc:dd:ee:51',
      status: 'dhcp', detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET description = 'kids tablet' WHERE subnet_id = ? AND ip_address = '10.0.1.51'")
      .run(subnetId);

    IpAddress.clearStaleDynamicMetadata(db);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.51');
    expect(row).toBeTruthy();
    expect(row.description).toBe('kids tablet');
    expect(row.hostname).toBeNull();
    expect(row.mac_address).toBeNull();
    expect(row.last_seen_mac).toBeNull();
    expect(row.last_seen_at).toBeNull();
    expect(row.detection_source).toBeNull();
    expect(row.status).toBe('available');
  });

  it('spares a reservation, a static DNS record, locked, and assigned', () => {
    db.prepare(`INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
                VALUES (?, '10.0.1.52', 'aa:bb:cc:dd:ee:52', 'printer', 1)`).run(subnetId);
    seedOffline('10.0.1.52', { mac_address: 'aa:bb:cc:dd:ee:52', hostname: 'printer', status: 'dhcp' });

    const zoneId = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('spare.test', 'forward', 1)")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'nas', 'A', '10.0.1.53', 'manual', 1)")
      .run(zoneId);
    seedOffline('10.0.1.53', { mac_address: 'aa:bb:cc:dd:ee:53', hostname: 'nas', status: 'dhcp' });

    seedOffline('10.0.1.54', { mac_address: 'aa:bb:cc:dd:ee:54', status: 'locked' });
    seedOffline('10.0.1.55', { mac_address: 'aa:bb:cc:dd:ee:55', status: 'assigned' });

    IpAddress.clearStaleDynamicMetadata(db);

    for (const ip of ['10.0.1.52', '10.0.1.53', '10.0.1.54', '10.0.1.55']) {
      const row = IpAddress.findBySubnetAndIp(db, subnetId, ip);
      expect(row, `${ip} should survive`).toBeTruthy();
      expect(row.mac_address, `${ip} should keep its MAC`).toBeTruthy();
      expect(row.last_seen_at, `${ip} should keep last_seen_at`).toBeTruthy();
    }
  });

  it('leaves a recently offline dynamic row alone', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.56', {
      hostname: 'asleep', mac_address: 'aa:bb:cc:dd:ee:56', status: 'dhcp'
    });
    db.prepare(`UPDATE ip_addresses SET is_online = 0, last_seen_at = datetime('now', '-1 hours')
                 WHERE subnet_id = ? AND ip_address = '10.0.1.56'`).run(subnetId);

    IpAddress.clearStaleDynamicMetadata(db);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.56');
    expect(row.mac_address).toBe('aa:bb:cc:dd:ee:56');
  });

  it('leaves an online row alone however old its last_seen_at', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.57', {
      is_online: 1, mac_address: 'aa:bb:cc:dd:ee:57', status: 'dhcp'
    });
    db.prepare(`UPDATE ip_addresses SET last_seen_at = datetime('now', '-30 days')
                 WHERE subnet_id = ? AND ip_address = '10.0.1.57'`).run(subnetId);

    IpAddress.clearStaleDynamicMetadata(db);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.57')).toBeTruthy();
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

  it('preserves existing detection_source ownership on scan updates', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.56', {
      hostname: 'dns-host.example.test',
      detection_source: 'dns'
    });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.56', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.56');
    expect(row.detection_source).toBe('dns');
    expect(row.hostname).toBe('dns-host.example.test');
    expect(row.last_scanned_at).toBeTruthy();
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

  it('marks restored DHCP lease history as rogue when it responds without active backing', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.57', {
      status: 'dhcp',
      hostname: 'old-lease',
      mac_address: 'aa:bb:cc:dd:ee:57',
      detection_source: 'dhcp_lease'
    });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.57', {
      responded: 1,
      mac: 'aa:bb:cc:dd:ee:57',
      isConflict: 1,
      conflictReason: 'Rogue device (IP not assigned)'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.57');
    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe('Rogue device (IP not assigned)');
  });

  it('does not mark active DHCP leases as rogue on conflict re-check', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.58', {
      status: 'dhcp',
      hostname: 'active-lease',
      mac_address: 'aa:bb:cc:dd:ee:58',
      detection_source: 'dhcp_lease'
    });
    db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id)
      VALUES ('10.0.1.58', 'aa:bb:cc:dd:ee:58', 'active-lease', NULL, datetime('now', '+1 hour'), ?)
    `).run(subnetId);

    IpAddress.updateFromScan(db, subnetId, '10.0.1.58', {
      responded: 1,
      mac: 'aa:bb:cc:dd:ee:58',
      isConflict: 1,
      conflictReason: 'Rogue device (IP not assigned)'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.58');
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('does not mark IPs with backing static DNS records as rogue when detection_source is stale', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('stale-source.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'testerella', 'A', '10.0.1.59', 'manual', 1)
    `).run(zone.lastInsertRowid);
    IpAddress.upsert(db, subnetId, '10.0.1.59', {
      status: 'available',
      hostname: 'testerella.stale-source.test',
      detection_source: 'scanner'
    });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.59', {
      responded: 1,
      mac: 'aa:bb:cc:dd:ee:59',
      isConflict: 1,
      conflictReason: 'Rogue device (IP not assigned)'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.59');
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('deletes ephemeral IPs when they do not respond', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.52', { is_online: 1 });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.52', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.52');
    expect(row).toBeUndefined();
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

// ── lifecycle: rogue cleared on offline ─────────────────

describe('rogue device goes offline', () => {
  it('bulkMarkStale ignores rows on a scanned subnet, leaving them to the scanner', () => {
    db.prepare('UPDATE subnets SET scan_interval = ? WHERE id = ?').run('30m', subnetId);
    try {
      IpAddress.upsert(db, subnetId, '10.0.1.80', {
        is_online: 1, is_rogue: 1, rogue_reason: 'Rogue device (IP not assigned)',
        detection_source: 'scanner'
      });

      db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.80'")
        .run(subnetId);

      IpAddress.bulkMarkStale(db, 60);

      const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.80');
      expect(row.is_online).toBe(1);
      expect(row.is_rogue).toBe(1);
    } finally {
      db.prepare('UPDATE subnets SET scan_interval = NULL WHERE id = ?').run(subnetId);
    }
  });

  it('bulkMarkStale deletes stale passive ephemeral rows', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.84', {
      is_online: 1,
      detection_source: 'passive'
    });

    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.84'")
      .run(subnetId);

    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.84');
    expect(row).toBeUndefined();
  });

  it('bulkMarkStale keeps stale passive persistent rows and clears rogue status', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.82', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch',
      hostname: 'known-host', detection_source: 'passive'
    });

    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.82'")
      .run(subnetId);

    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.82');
    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('markOffline deletes ephemeral rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.81', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.81');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.81');
    expect(row).toBeUndefined();
  });

  it('markOffline keeps persistent rogue (locked status) and clears rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.83', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch', status: 'locked'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.83');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.83');
    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });
});

// The appliance probes and resolves through its own interfaces, so both the
// scanner and the passive DNS path see its own addresses answering. Neither
// treated that as a claim, so an interface address without a DNS record was
// recorded as a rogue device.
describe('recordPassiveActivity: the appliance own addresses are not rogue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLocalAddressCache();
  });

  it('does not create a rogue row for a local address', () => {
    resetLocalAddressCache();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth1: [{ address: '10.0.1.99', family: 'IPv4', internal: false }]
    });

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.99', { createRogue: true });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.99');
    expect(row).toBeTruthy();
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBeNull();
  });

  it('still creates a rogue row for an address that is not ours', () => {
    resetLocalAddressCache();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth1: [{ address: '10.0.1.99', family: 'IPv4', internal: false }]
    });

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.98', { createRogue: true });

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.98').is_rogue).toBe(1);
  });
});
