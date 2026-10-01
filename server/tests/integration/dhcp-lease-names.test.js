/**
 * ADR 005: a DHCP lease name is unique in its zone and sticky to the address
 * that holds it. Driven through syncLeases with real lease files, the way
 * dnsmasq hands one client name to whichever client renewed last.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));

let tmpDir;
let db;
let syncLeases;
let leaseFile;

const FAR = 4102444800;
const DECO_A = '54:af:97:51:2b:e7';
const DECO_B = '54:af:97:51:26:c9';

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  // DATA_DIR is read when utils/dhcp.js loads, so it loads after setupTestDb.
  ({ syncLeases } = await import('../../src/utils/dhcp.js'));
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
