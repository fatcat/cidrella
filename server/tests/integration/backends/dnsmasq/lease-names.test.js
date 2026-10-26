/**
 * ADR 005: a DHCP lease name is unique in its zone and sticky to the address
 * that holds it. Driven through lease ingestion with real lease files, the way
 * dnsmasq hands one client name to whichever client renewed last.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../../../helpers/test-db.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));

let tmpDir;
let db;
let parseLeaseFile;
let ingestLeases;
let syncLeasesNow;
let invalidateSubnetCache;
let retireStaleDynamicAddresses;
let leaseFile;
let computeIpView;

const FAR = 4102444800;
const DECO_A = '54:af:97:51:2b:e7';
const DECO_B = '54:af:97:51:26:c9';

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  // DATA_DIR is read when backends/dnsmasq/dhcp.js loads, so it loads after setupTestDb.
  ({ parseLeaseFile } = await import('../../../../src/backends/dnsmasq/dhcp.js'));
  ({ ingestLeases, syncLeasesNow } = await import('../../../../src/services/dhcp-lease-sync.js'));
  ({ invalidateSubnetCache } = await import('../../../../src/utils/ip-sync.js'));
  ({ computeIpView } = await import('../../../../src/models/ip-view.js'));
  ({ retireStaleDynamicAddresses } =
    await import('../../../../src/services/ip-lifecycle-service.js'));
  leaseFile = path.join(tmpDir, 'dnsmasq', 'dnsmasq.leases');
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });

  const subnetId = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, status, domain_name)
       VALUES ('10.0.1.0/24', 'Lan', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated', 'example.test')`,
    )
    .run().lastInsertRowid;
  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db
    .prepare(
      `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
       VALUES (?, ?, '10.0.1.20', '10.0.1.250')`,
    )
    .run(subnetId, rangeTypeId).lastInsertRowid;
  const scopeId = db
    .prepare("INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time) VALUES (?, ?, '15m')")
    .run(rangeId, subnetId).lastInsertRowid;
  db.prepare(
    `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
     VALUES (?, ?, '10.0.1.20', '10.0.1.250')`,
  ).run(scopeId, rangeId);
  db.prepare(
    "INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)",
  ).run();
  db.prepare(
    "INSERT INTO dns_zones (name, type, enabled) VALUES ('1.0.10.in-addr.arpa', 'reverse', 1)",
  ).run();
  db.prepare(
    "INSERT INTO mac_vendors (prefix, prefix_length, short_name, vendor_name) VALUES ('54:AF:97', 24, 'TP-Link', 'TP-LINK TECHNOLOGIES')",
  ).run();
});

afterAll(() => cleanupTestDb(tmpDir));

// One read of the lease file, no settling: what a sync does with this text.
function syncLeases(db, { leaseFile }) {
  const leases = parseLeaseFile(fs.readFileSync(leaseFile, 'utf8'));
  return leases ? ingestLeases(db, leases) : { synced: 0, unsettled: true };
}

function renew(lines) {
  fs.writeFileSync(leaseFile, lines.map((line) => `${FAR} ${line}`).join('\n') + '\n');
  syncLeases(db, { leaseFile });
}
const leaseName = (ip) =>
  db.prepare('SELECT hostname FROM dhcp_leases WHERE ip_address = ?').get(ip)?.hostname;
const canonicalName = (ip) =>
  db.prepare('SELECT hostname FROM ip_addresses WHERE ip_address = ?').get(ip)?.hostname;
// Every DHCP-derived A record and PTR, ids included, so a delete and re-insert
// of the same name shows up as a change.
const records = () =>
  db
    .prepare(
      `SELECT r.id, z.name AS zone, r.name, r.type, r.value FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.source = 'dhcp' ORDER BY r.id`,
    )
    .all();

describe('DHCP lease names (ADR 005)', () => {
  it('stops two clients sending one name from swapping it on every renewal', () => {
    // dnsmasq gives deco-XE75 to whichever unit renewed last and writes '*'
    // for the other, alternating every renewal.
    const aNamed = [`${DECO_A} 10.0.1.161 deco-XE75 *`, `${DECO_B} 10.0.1.216 * *`];
    const bNamed = [`${DECO_A} 10.0.1.161 * *`, `${DECO_B} 10.0.1.216 deco-XE75 *`];

    renew(aNamed);
    expect(leaseName('10.0.1.161')).toBe('deco-XE75');
    expect(leaseName('10.0.1.216')).toBe('tplink-device');

    // B now sends the name A holds: A keeps it, B takes the first suffix.
    renew(bNamed);
    expect(leaseName('10.0.1.161')).toBe('deco-XE75');
    expect(leaseName('10.0.1.216')).toBe('deco-XE75-00');
    const settled = records();
    expect(settled.map(({ zone, name, value }) => [zone, name, value])).toEqual(
      expect.arrayContaining([
        ['example.test', 'deco-xe75', '10.0.1.161'],
        ['example.test', 'deco-xe75-00', '10.0.1.216'],
        ['1.0.10.in-addr.arpa', '161', 'deco-xe75.example.test'],
        ['1.0.10.in-addr.arpa', '216', 'deco-xe75-00.example.test'],
      ]),
    );

    // From here on the renewals change nothing: no record moves or is rewritten.
    for (const lines of [aNamed, bNamed, aNamed, bNamed]) {
      renew(lines);
      expect(records()).toEqual(settled);
      expect(leaseName('10.0.1.161')).toBe('deco-XE75');
      expect(leaseName('10.0.1.216')).toBe('deco-XE75-00');
    }
    expect(canonicalName('10.0.1.161')).toBe('deco-XE75');
    expect(canonicalName('10.0.1.216')).toBe('deco-XE75-00');
  });

  it('gives a second unnamed client of one vendor a suffixed fallback name', () => {
    renew([`54:af:97:00:00:01 10.0.1.30 * *`, `54:af:97:00:00:02 10.0.1.31 * *`]);
    expect(leaseName('10.0.1.30')).toBe('tplink-device');
    expect(leaseName('10.0.1.31')).toBe('tplink-device-00');
    // Reversing the order in the lease file does not move either name.
    renew([`54:af:97:00:00:02 10.0.1.31 * *`, `54:af:97:00:00:01 10.0.1.30 * *`]);
    expect(leaseName('10.0.1.30')).toBe('tplink-device');
    expect(leaseName('10.0.1.31')).toBe('tplink-device-00');
  });

  it('names an unnamed DHCPv6 client by the MAC its DUID embeds (IPV6-22)', () => {
    const v6 = db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, last_address, prefix_length,
           address_family, status, domain_name)
         VALUES ('fd00:a1::/64', 'Lan6', 'fd00:a1::', 'fd00:a1::ffff:ffff:ffff:ffff', 64, 6,
           'allocated', 'example.test')`,
      )
      .run().lastInsertRowid;
    const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const rangeId = db
      .prepare(
        `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
         VALUES (?, ?, 'fd00:a1::1000', 'fd00:a1::1fff')`,
      )
      .run(v6, rangeTypeId).lastInsertRowid;
    const scopeId = db
      .prepare(
        `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode)
         VALUES (?, ?, '15m', 6, 'stateful')`,
      )
      .run(rangeId, v6).lastInsertRowid;
    db.prepare(
      `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
       VALUES (?, ?, 'fd00:a1::1000', 'fd00:a1::1fff')`,
    ).run(scopeId, rangeId);
    db.prepare('UPDATE dhcp_scopes SET enabled = 1 WHERE id = ?').run(scopeId);
    invalidateSubnetCache();

    // DUID-LLT (type 1, Ethernet) and DUID-LL (type 3) embed the MAC;
    // DUID-EN (type 2) does not, so that client stays unnamed.
    renew([
      `12345 fd00:a1::1010 * 00:01:00:01:2e:3f:40:51:54:af:97:00:00:61`,
      `12346 fd00:a1::1011 * 00:03:00:01:54:af:97:00:00:62`,
      `12347 fd00:a1::1012 * 00:02:00:00:ab:11:65:6e:74:65:72:70:72:69:73:65`,
    ]);
    const named = [leaseName('fd00:a1::1010'), leaseName('fd00:a1::1011')];
    expect(named.every((name) => /^tplink-device(-\d+)?$/.test(name))).toBe(true);
    expect(new Set(named).size).toBe(2);
    expect(leaseName('fd00:a1::1012')).toBeNull();
    // Naming only: the lease's MAC of record stays empty.
    expect(
      db.prepare("SELECT mac_address FROM dhcp_leases WHERE ip_address = 'fd00:a1::1010'").get(),
    ).toEqual({ mac_address: null });
  });

  it('syncs a lease file only once dnsmasq has finished rewriting it', async () => {
    // One IPv4 and one IPv6 lease (the IPv6 pool is the one the test above made).
    const lines = [
      `aa:bb:cc:00:00:70 10.0.1.70 nanoleaf *`,
      `12348 fd00:a1::1070 lamp6 00:03:00:01:aa:bb:cc:00:00:71`,
    ];
    renew(lines);
    const ips = ['10.0.1.70', 'fd00:a1::1070'];
    const history = () =>
      db
        .prepare(
          `SELECT ip_address, event_type FROM ip_events
           WHERE ip_address IN (?, ?) ORDER BY id`,
        )
        .all(...ips);
    const settled = history();
    const whole = lines.map((line) => `${FAR} ${line}`).join('\n') + '\n';
    const firstLine = whole.slice(0, whole.indexOf('\n') + 1);

    // A read that stops part way through a line is left for the next sync.
    fs.writeFileSync(leaseFile, whole.slice(0, whole.indexOf('nanoleaf') + 4));
    expect(syncLeases(db, { leaseFile })).toEqual({ synced: 0, unsettled: true });

    // dnsmasq truncates, then writes lease by lease: the reader waits until
    // two reads agree, so the empty and the one-lease files are never synced.
    const writes = [firstLine, whole, whole];
    fs.writeFileSync(leaseFile, '');
    const result = await syncLeasesNow(db, {
      leaseFile,
      wait: async () => fs.writeFileSync(leaseFile, writes.shift()),
    });
    expect(result).toMatchObject({ synced: 2 });
    expect(history()).toEqual(settled);
    expect(ips.map(leaseName)).toEqual(['nanoleaf', 'lamp6']);
    expect(ips.map(canonicalName)).toEqual(['nanoleaf', 'lamp6']);

    // A file that never settles syncs nothing.
    let n = 0;
    const churn = await syncLeasesNow(db, {
      leaseFile,
      wait: async () => fs.writeFileSync(leaseFile, n++ % 2 ? whole : firstLine),
    });
    expect(churn).toEqual({ synced: 0, unsettled: true });
    expect(history()).toEqual(settled);
  });

  it('treats a manual record of the name as taken and leaves the record alone', () => {
    const zoneId = db.prepare("SELECT id FROM dns_zones WHERE name = 'example.test'").get().id;
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'printer', 'A', '10.0.1.5', 'manual', 1)",
    ).run(zoneId);
    renew([`aa:bb:cc:00:00:40 10.0.1.40 printer *`]);
    expect(leaseName('10.0.1.40')).toBe('printer-00');
    expect(
      db.prepare("SELECT value FROM dns_records WHERE name = 'printer' AND type = 'A'").all(),
    ).toEqual([{ value: '10.0.1.5' }]);
  });

  it('leaves a lease unnamed when the name and all 256 suffixes are taken', () => {
    const zoneId = db.prepare("SELECT id FROM dns_zones WHERE name = 'example.test'").get().id;
    const insert = db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, 'A', '10.0.1.6', 'manual', 1)",
    );
    insert.run(zoneId, 'busy');
    for (let i = 0; i < 256; i++) insert.run(zoneId, `busy-${i.toString(16).padStart(2, '0')}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renew([`aa:bb:cc:00:00:50 10.0.1.50 busy *`]);
    expect(leaseName('10.0.1.50')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('all 256 suffixes are taken'));
    warn.mockRestore();
  });
});

// A client that leaves and comes back on another address (Kea hands out the
// next free one) used to find its own old record holding its name, and took
// -00, -01 and so on every time; the old records were never removed.
describe('a client coming back on a new address (ADR 005)', () => {
  const nameRecords = (base) =>
    db
      .prepare(
        `SELECT r.name, r.type, r.value FROM dns_records r
         WHERE r.source = 'dhcp' AND (r.name = ? OR r.name LIKE ? OR r.value LIKE ?)
         ORDER BY r.type, r.name, r.value`,
      )
      .all(base, `${base}-%`, `${base}%`);
  const setLiveness = (ip, online, offlineSince = null) =>
    db
      .prepare('UPDATE ip_addresses SET is_online = ?, offline_since_at = ? WHERE ip_address = ?')
      .run(online ? 1 : 0, offlineSince, ip);
  // The host was last heard this many seconds from now (negative: ago).
  const heardAt = (ip, seconds) =>
    db
      .prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', ?) WHERE ip_address = ?")
      .run(`${seconds >= 0 ? '+' : ''}${seconds} seconds`, ip);

  // IPv4 by the lease's MAC, IPv6 by the MAC its DUID-LL embeds. The IPv6
  // subnet is the one the DHCPv6 naming test above made.
  const families = [
    {
      family: 'IPv4',
      lease: (mac, ip, name) => `${mac} ${ip} ${name} *`,
      mac: 'aa:bb:cc:00:01:01',
      other: 'aa:bb:cc:00:01:02',
      first: '10.0.1.101',
      second: '10.0.1.102',
      third: '10.0.1.103',
      ptr: (ip) => ip.split('.').pop(),
      type: 'A',
    },
    {
      family: 'IPv6',
      lease: (mac, ip, name) => `${parseInt(mac.slice(-2), 16)} ${ip} ${name} 00:03:00:01:${mac}`,
      mac: 'aa:bb:cc:00:06:01',
      other: 'aa:bb:cc:00:06:02',
      first: 'fd00:a1::1101',
      second: 'fd00:a1::1102',
      third: 'fd00:a1::1103',
      type: 'AAAA',
    },
  ];

  it('suffixes a returning DHCPv6 client, whose address keeps no MAC to know it by', () => {
    const f = families[1];
    const base = 'laptopv6-unknown';
    renew([f.lease(f.mac, f.first, base)]);
    setLiveness(f.first, false, new Date().toISOString());
    renew([f.lease(f.mac, f.second, base)]);
    expect(leaseName(f.second)).toBe(`${base}-00`);
  });

  for (const f of families.slice(0, 1)) {
    it(`gives the client its own name back, and still suffixes another client (${f.family})`, () => {
      const base = `laptop${f.family.toLowerCase()}`;
      renew([f.lease(f.mac, f.first, base)]);
      expect(leaseName(f.first)).toBe(base);

      // The lease is gone and the host went quiet: the old record is still in
      // its retention window when the client asks again from a new address.
      setLiveness(f.first, false, new Date().toISOString());
      renew([f.lease(f.mac, f.second, base)]);
      expect(leaseName(f.second)).toBe(base);
      expect(nameRecords(base).filter((r) => r.type === f.type)).toEqual([
        { name: base, type: f.type, value: f.second },
      ]);
      if (f.ptr) {
        expect(
          db
            .prepare("SELECT name, value FROM dns_records WHERE type = 'PTR' AND value LIKE ?")
            .all(`${base}.%`),
        ).toEqual([{ name: f.ptr(f.second), value: `${base}.example.test` }]);
      }

      // A different client asking for the name still gets a suffix.
      renew([f.lease(f.mac, f.second, base), f.lease(f.other, f.third, base)]);
      expect(leaseName(f.second)).toBe(base);
      expect(leaseName(f.third)).toBe(`${base}-00`);
    });
  }

  it('gives the name back the same way when retirement ran before the client returned', async () => {
    const f = families[0];
    const base = 'laptopafter';
    renew([f.lease(f.mac, f.first, base)]);
    db.prepare('DELETE FROM dhcp_leases WHERE ip_address = ?').run(f.first);
    renew([f.lease(f.other, f.third, 'bystander')]);
    setLiveness(f.first, false, new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    await retireStaleDynamicAddresses(db, { releaseLease: () => ({ released: true }) });
    expect(nameRecords(base)).toEqual([]);

    renew([f.lease(f.other, f.third, 'bystander'), f.lease(f.mac, f.second, base)]);
    expect(leaseName(f.second)).toBe(base);
    expect(nameRecords(base).filter((r) => r.type === f.type)).toEqual([
      { name: base, type: f.type, value: f.second },
    ]);
  });

  for (const f of families) {
    it(`retires a lease record whose address has no row, once it is an hour stale (${f.family})`, async () => {
      const zoneId = db.prepare("SELECT id FROM dns_zones WHERE name = 'example.test'").get().id;
      const ip = f.family === 'IPv4' ? '10.0.1.199' : 'fd00:a1::1199';
      const insert = db.prepare(
        `INSERT INTO dns_records (zone_id, name, type, value, source, enabled, updated_at)
         VALUES (?, ?, ?, ?, 'dhcp', 1, ?)`,
      );
      insert.run(zoneId, `rowless${f.family}`.toLowerCase(), f.type, ip, '2000-01-01 00:00:00');
      const freshIp = f.family === 'IPv4' ? '10.0.1.198' : 'fd00:a1::1198';
      insert.run(
        zoneId,
        `fresh${f.family}`.toLowerCase(),
        f.type,
        freshIp,
        new Date().toISOString(),
      );
      expect(
        db.prepare('SELECT 1 FROM ip_addresses WHERE ip_address IN (?, ?)').all(ip, freshIp),
      ).toEqual([]);

      await retireStaleDynamicAddresses(db, { releaseLease: () => ({ released: true }) });
      const left = db
        .prepare('SELECT value FROM dns_records WHERE value IN (?, ?) ORDER BY value')
        .all(ip, freshIp)
        .map((r) => r.value);
      expect(left).toEqual([freshIp]);
      db.prepare('DELETE FROM dns_records WHERE value = ?').run(freshIp);
    });

    it(`removes a lease's record at once when it lapses while the host is online (${f.family})`, () => {
      const base = `tv${f.family.toLowerCase()}`;
      const keep = f.lease(f.other, f.third, 'keeper');
      renew([f.lease(f.mac, f.first, base), keep]);
      expect(nameRecords(base).filter((r) => r.type === f.type)).toHaveLength(1);

      // Online means heard after the lease ended, not just the flag: the lease
      // ends when it leaves the file, so the host is heard a minute later.
      setLiveness(f.first, true);
      heardAt(f.first, 60);
      if (f.family === 'IPv6') {
        // A DHCPv6 lease holds its address for its valid lifetime.
        db.prepare("UPDATE ip_addresses SET valid_until = '2000-01-01' WHERE ip_address = ?").run(
          f.first,
        );
      }
      renew([keep]);
      expect(nameRecords(base)).toEqual([]);
      expect(canonicalName(f.first)).toBeNull();
    });

    // A lease running out, as the next sync sees it. `listed`: the backend
    // still lists it with its past expiry (dnsmasq until it prunes the file,
    // Kea until it reclaims the lease); otherwise it has dropped it and the
    // sync keeps the expired row. Either way the expiry is unchanged since the
    // previous sync, where it was still ahead.
    function lapse(ip, line, expiredSecondsAgo, { listed }) {
      const past = Math.floor(Date.now() / 1000) - expiredSecondsAgo;
      db.prepare('UPDATE dhcp_leases SET expires_at = ? WHERE ip_address = ?').run(
        new Date(past * 1000).toISOString(),
        ip,
      );
      if (f.family === 'IPv6') {
        db.prepare("UPDATE ip_addresses SET valid_until = '2000-01-01' WHERE ip_address = ?").run(
          ip,
        );
      }
      fs.writeFileSync(leaseFile, listed ? `${past} ${line}\n` : '');
      syncLeases(db, { leaseFile });
    }
    const liveness = (ip) => db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get(ip);

    for (const listed of [true, false]) {
      const how = listed ? 'still listed' : 'dropped';
      it(`takes a silent holder offline when its lease runs out, not as a rogue (${f.family}, ${how})`, () => {
        const ip = listed ? f.second : f.first;
        const base = `quiet${listed ? 'l' : 'd'}${f.family.toLowerCase()}`;
        const line = f.lease(f.mac, ip, base);
        renew([line]);
        expect(liveness(ip)).toMatchObject({ is_online: 1, allocation_state: 'dynamic_dhcp' });
        // Last heard ten minutes ago, the lease ran out one minute ago: the
        // online flag is still set, as a forgiven scan miss leaves it.
        heardAt(ip, -600);
        const obtained = () =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM ip_events WHERE ip_address = ? AND event_type = 'lease_obtained'",
            )
            .get(ip).n;
        const obtainedBefore = obtained();
        lapse(ip, line, 60, { listed });

        const row = liveness(ip);
        expect(row).toMatchObject({ is_online: 0, allocation_state: 'unassigned', is_rogue: 0 });
        expect(row.offline_since_at).not.toBeNull();
        expect(computeIpView(row).address_type).toBeNull();
        const offline = db
          .prepare(
            "SELECT source FROM ip_events WHERE ip_address = ? AND event_type = 'offline' ORDER BY id DESC",
          )
          .get(ip);
        expect(offline).toEqual({ source: 'dhcp_lease' });
        // The expired lease is not a new one.
        expect(obtained()).toBe(obtainedBefore);
        // Offline, its lease name stays for the retention window.
        expect(canonicalName(ip)).toBe(base);
      });
    }

    it(`keeps a holder heard after its lease ran out online, as a rogue (${f.family})`, () => {
      const base = `stays${f.family.toLowerCase()}`;
      const line = f.lease(f.mac, f.third, base);
      renew([line]);
      heardAt(f.third, 0);
      lapse(f.third, line, 60, { listed: false });

      const row = liveness(f.third);
      expect(row).toMatchObject({ is_online: 1, allocation_state: 'unassigned' });
      expect(computeIpView(row).address_type).toBe('rogue');
    });

    it(`retires a lapsed lease's record that an earlier release left behind (${f.family})`, async () => {
      const base = `stale${f.family.toLowerCase()}`;
      renew([f.lease(f.mac, f.first, base)]);
      // What a lease that lapsed with the host online left before this fix:
      // the address unassigned with no detection source, the record still up.
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      db.prepare(
        `UPDATE ip_addresses SET allocation_state = 'unassigned', allocation_source_type = NULL,
           allocation_source_id = NULL, hostname = NULL, detection_source = NULL,
           is_online = 0, offline_since_at = ?, dhcp_version = NULL, dhcp_duid = NULL
         WHERE ip_address = ?`,
      ).run(twoHoursAgo, f.first);
      db.prepare('DELETE FROM dhcp_leases WHERE ip_address = ?').run(f.first);
      expect(nameRecords(base).filter((r) => r.type === f.type)).toHaveLength(1);

      const result = await retireStaleDynamicAddresses(db, {
        releaseLease: () => ({ released: true }),
      });
      expect(result.dnsRecordsRemoved).toBeGreaterThanOrEqual(1);
      expect(nameRecords(base)).toEqual([]);
      expect(
        db
          .prepare('SELECT mac_address, offline_since_at FROM ip_addresses WHERE ip_address = ?')
          .get(f.first),
      ).toEqual({ mac_address: null, offline_since_at: null });
    });
  }
});
