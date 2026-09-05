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
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  db.prepare('DELETE FROM scan_results').run();
  db.prepare('DELETE FROM network_scans').run();
});

// ── upsert ──────────────────────────────────────────────

describe('upsert', () => {
  it('uses interface context only for IPv6 link-local identities', () => {
    expect(() => IpAddress.upsert(db, subnetId, '2001:db8::10', {
      interface_id: 'eth0'
    })).toThrow(/only valid for IPv6 link-local/);
    expect(() => IpAddress.upsert(db, subnetId, 'fe80::10', {
      interface_id: '   '
    })).toThrow(/require interface context/);

    IpAddress.upsert(db, subnetId, 'fe80::10', { interface_id: 'eth0' });
    expect(IpAddress.findBySubnetAndIp(db, subnetId, 'fe80::10%eth0'))
      .toMatchObject({ ip_address: 'fe80::10', interface_id: 'eth0' });
  });

  it('enforces interface scope for direct database writes', () => {
    const insert = db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, address_family, address_sort_key, interface_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    expect(() => insert.run(subnetId, '2001:db8::11', 6, 'key', 'eth0'))
      .toThrow(/interface context/);
    expect(() => insert.run(subnetId, '2001:db8::11', 6, 'key', ''))
      .toThrow(/interface context/);
    expect(() => insert.run(subnetId, 'fe80::11', 6, 'key', null))
      .toThrow(/interface context/);
    expect(() => insert.run(subnetId, 'fe80::11', 6, 'key', '   '))
      .toThrow(/interface context/);
  });

  it('inserts a new IP with defaults', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.10', { hostname: 'web1' });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.10');

    expect(row).toBeTruthy();
    expect(row.hostname).toBe('web1');
    expect(row.allocation_state).toBe('unassigned');
    expect(row).not.toHaveProperty('status');
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
    IpAddress.upsert(db, subnetId, '10.0.1.14', { hostname: 'same', allocation_state: 'static_dns' });
    const first = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.14');

    // Same values, updated_at should not change
    IpAddress.upsert(db, subnetId, '10.0.1.14', { hostname: 'same', allocation_state: 'static_dns' });
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
    expect(row.allocation_state).toBe('unassigned');
    expect(row.rogue_reason).toBe('passive DNS query from unassigned address');
  });
});

describe('recordPassiveActivity: canonical allocation owns claims', () => {
  it('keeps an allocated address non-rogue and marks it online', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.30', {
      allocation_state: 'static_dns',
      hostname: 'pve-01.example.test'
    });

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.30', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30');

    expect(row).toMatchObject({ is_online: 1, is_rogue: 0, allocation_state: 'static_dns' });
  });

  it('does not infer allocation from a raw DNS record', () => {
    const zoneId = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'nas', 'A', '10.0.1.31', 'manual', 1)")
      .run(zoneId);

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.31', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31');

    expect(row).toMatchObject({ is_online: 1, is_rogue: 1, allocation_state: 'unassigned' });
  });

  it('leaves an existing conflict classification alone', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.32', {
      allocation_state: 'static_dns',
      is_rogue: 1,
      rogue_reason: 'MAC mismatch'
    });

    IpAddress.recordPassiveActivity(db, subnetId, '10.0.1.32', { createRogue: true });
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.32');

    expect(row.is_rogue).toBe(1);
    expect(row.rogue_reason).toBe('MAC mismatch');
  });
});

describe('markOffline', () => {
  it('retains learned data and starts the continuous-offline interval', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.22', { is_online: 1, is_rogue: 1, rogue_reason: 'test' });
    IpAddress.markOffline(db, subnetId, '10.0.1.22');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.22');

    expect(row).toMatchObject({ is_online: 0, is_rogue: 0, rogue_reason: 'test' });
    expect(row.last_seen_at).toBeTruthy();
    expect(row.offline_since_at).toBeTruthy();
  });

  it('keeps persistent IPs (with hostname) and clears rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.23', { is_online: 1, is_rogue: 1, rogue_reason: 'test', hostname: 'server1' });
    IpAddress.markOffline(db, subnetId, '10.0.1.23');
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.23');

    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBe('test');
    expect(row.offline_since_at).toBeTruthy();
  });

  it('keeps DHCP rows offline even without a hostname', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.24', {
      allocation_state: 'dynamic_dhcp',
      mac_address: 'aa:bb:cc:dd:ee:24',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.24');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.24');
    expect(row).toBeTruthy();
    expect(row.is_online).toBe(0);
    expect(row.allocation_state).toBe('dynamic_dhcp');
  });
});

// ── bulkMarkStale ───────────────────────────────────────

describe('bulkMarkStale', () => {
  it('marks stale ephemeral IPs offline without retiring their metadata yet', () => {
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

    expect(stale).toMatchObject({ is_online: 0, is_rogue: 0 });
    expect(stale.offline_since_at).toBeTruthy();
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
    expect(row.rogue_reason).toBe('rogue');
    expect(row.hostname).toBe('db-server');
  });

  it('marks stale DHCP rows offline when the scanner does not cover them', () => {
    // Holding a lease is not evidence the host is up, and with no scan interval
    // configured nothing else will ever disprove it.
    IpAddress.upsert(db, subnetId, '10.0.1.33', {
      allocation_state: 'dynamic_dhcp',
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
        allocation_state: 'dynamic_dhcp',
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

// ── isAdminDeclared ──────────────────────────────────────

describe('isAdminDeclared', () => {
  it('recognizes only canonical administrative and static allocations', () => {
    for (const allocation_state of ['reserved', 'static_dns', 'static_dhcp', 'system', 'gateway']) {
      expect(IpAddress.isAdminDeclared(db, { allocation_state })).toBe(true);
    }
  });

  it('rejects observed and unassigned canonical allocations', () => {
    for (const allocation_state of ['unassigned', 'dynamic_dhcp', 'slaac', 'quarantined']) {
      expect(IpAddress.isAdminDeclared(db, { allocation_state })).toBe(false);
    }
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
    IpAddress.upsert(db, subnetId, '10.0.1.50', { allocation_state: 'static_dns', mac_address: 'aa:bb:cc:dd:ee:01' });

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
      allocation_state: 'unassigned',
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
      allocation_state: 'dynamic_dhcp',
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

  it('does not mark canonical static DNS allocations rogue when detection_source is stale', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('stale-source.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'testerella', 'A', '10.0.1.59', 'manual', 1)
    `).run(zone.lastInsertRowid);
    IpAddress.upsert(db, subnetId, '10.0.1.59', {
      allocation_state: 'static_dns',
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

  it('starts retirement timing when an ephemeral IP does not respond', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.52', { is_online: 1 });

    IpAddress.updateFromScan(db, subnetId, '10.0.1.52', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.52');
    expect(row).toMatchObject({ is_online: 0, is_rogue: 0 });
    expect(row.offline_since_at).toBeTruthy();
  });

  it('creates new row for responding rogue with no existing record', () => {
    IpAddress.updateFromScan(db, subnetId, '10.0.1.53', {
      responded: 1, mac: 'de:ad:be:ef:00:01', isConflict: 1, conflictReason: 'Rogue device (IP not assigned)'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.53');
    expect(row).toBeTruthy();
    expect(row.allocation_state).toBe('unassigned');
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

// ── setScanEnabled ──────────────────────────────────────

describe('setScanEnabled', () => {
  it('creates IP with scan_enabled override', () => {
    IpAddress.setScanEnabled(db, subnetId, '10.0.1.70', 0);
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.70');

    expect(row.scan_enabled).toBe(0);
    expect(row.allocation_state).toBe('unassigned');
  });

  it('updates scan_enabled on existing row', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.71', {});
    IpAddress.setScanEnabled(db, subnetId, '10.0.1.71', 1);
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.71');

    expect(row.scan_enabled).toBe(1);
  });
});

// ── lifecycle: rogue classification ends on offline ─────

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

  it('bulkMarkStale retains stale passive metadata for retirement', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.84', {
      is_online: 1,
      detection_source: 'passive'
    });

    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-2 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.84'")
      .run(subnetId);

    IpAddress.bulkMarkStale(db, 60);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.84');
    expect(row).toMatchObject({ is_online: 0, is_rogue: 0 });
    expect(row.offline_since_at).toBeTruthy();
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
    expect(row.rogue_reason).toBe('MAC mismatch');
  });

  it('markOffline retains ephemeral rogue metadata until retirement', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.81', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.81');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.81');
    expect(row).toMatchObject({ is_online: 0, is_rogue: 0, rogue_reason: 'MAC mismatch' });
    expect(row.offline_since_at).toBeTruthy();
  });

  it('markOffline keeps persistent reserved rows and clears rogue', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.83', {
      is_online: 1, is_rogue: 1, rogue_reason: 'MAC mismatch', allocation_state: 'reserved'
    });

    IpAddress.markOffline(db, subnetId, '10.0.1.83');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.83');
    expect(row.is_online).toBe(0);
    expect(row.is_rogue).toBe(0);
    expect(row.rogue_reason).toBe('MAC mismatch');
  });
});
