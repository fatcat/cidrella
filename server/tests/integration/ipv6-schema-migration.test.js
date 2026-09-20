/**
 * Migrations 070-072 rebuild parent tables. With foreign keys enforced, SQLite
 * runs ON DELETE CASCADE when the old parent is dropped, which would empty every
 * child table. The runner turns enforcement off around those migrations and
 * verifies referential integrity before recording the version. This test seeds
 * a full topology at schema 069, upgrades through initDb, and checks nothing
 * was lost. It also demonstrates the hazard the runner guards against.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../../src/db/init.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];

function migrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function versionOf(file) {
  return Number.parseInt(file.split('_')[0], 10);
}

function databaseThrough(targetVersion) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-ipv6-schema-'));
  tmpDirs.push(tmpDir);
  for (const dir of ['dnsmasq/hosts.d', 'dnsmasq/dhcp-hosts.d', 'dnsmasq/conf.d', 'certs']) {
    fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
  }
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const apply = db.transaction((sql, version) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });
  for (const file of migrationFiles()) {
    const version = versionOf(file);
    if (version > targetVersion) continue;
    apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
  }
  return { db, tmpDir };
}

function seedTopology(db) {
  const parent = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, depth) VALUES ('10.70.0.0/23', 'parent', '10.70.0.0',
        '10.70.1.255', 23, 512, 'unallocated', 0)`,
    )
    .run().lastInsertRowid;
  const child = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, gateway_policy, parent_id, status, depth,
        domain_name) VALUES ('10.70.0.0/24', 'child', '10.70.0.0', '10.70.0.255', 24, 256,
        '10.70.0.1', 'first', ?, 'allocated', 1, 'lab.test')`,
    )
    .run(parent).lastInsertRowid;
  const rangeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const range = db
    .prepare(
      `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
       VALUES (?, ?, '10.70.0.100', '10.70.0.150')`,
    )
    .run(child, rangeType).lastInsertRowid;
  const scope = db
    .prepare('INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time) VALUES (?, ?, ?)')
    .run(range, child, '12h').lastInsertRowid;
  db.prepare(
    'INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip) VALUES (?, ?, ?, ?)',
  ).run(scope, range, '10.70.0.100', '10.70.0.150');
  db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, 3, ?)').run(
    scope,
    '10.70.0.1',
  );
  db.prepare(
    `INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default)
     VALUES (66, '10.70.0.2', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO dhcp_custom_options (code, name, label) VALUES (150, 'tftp', 'TFTP server')`,
  ).run();
  db.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname)
     VALUES (?, 'aa:bb:cc:dd:ee:01', '10.70.0.20', 'printer')`,
  ).run(child);
  db.prepare(
    `INSERT INTO dhcp_leases (ip_address, mac_address, hostname, expires_at, subnet_id)
     VALUES ('10.70.0.120', 'aa:bb:cc:dd:ee:02', 'laptop', '2099-01-01T00:00:00.000Z', ?)`,
  ).run(child);
  for (const [ip, state] of [
    ['10.70.0.0', 'system'],
    ['10.70.0.1', 'gateway'],
    ['10.70.0.20', 'static_dhcp'],
    ['10.70.0.120', 'dynamic_dhcp'],
  ]) {
    db.prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state, address_family,
        address_sort_key) VALUES (?, ?, ?, 4, ?)`,
    ).run(child, ip, state, ip);
  }
  db.prepare(`INSERT INTO network_scans (subnet_id, status) VALUES (?, 'completed')`).run(child);
  const zone = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('lab.test', 'forward', 1)")
    .run().lastInsertRowid;
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, source)
     VALUES (?, 'printer', 'A', '10.70.0.20', 'reservation')`,
  ).run(zone);
  db.prepare(
    `INSERT INTO rogue_dhcp_events (server_ip, server_identifier, offered_ip, iface, acknowledged)
     VALUES ('10.70.0.250', '10.70.0.250', '10.70.0.77', 'eth0', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO dhcp_authorized_servers (server_ip, server_mac, description)
     VALUES ('10.70.0.2', 'aa:bb:cc:dd:ee:03', 'core router')`,
  ).run();
  return { parent, child, scope };
}

const COUNTED_TABLES = [
  'subnets',
  'ranges',
  'dhcp_scopes',
  'dhcp_scope_pools',
  'dhcp_scope_options',
  'dhcp_option_defaults',
  'dhcp_custom_options',
  'dhcp_reservations',
  'dhcp_leases',
  'ip_addresses',
  'network_scans',
  'dns_zones',
  'dns_records',
  'rogue_dhcp_events',
  'dhcp_authorized_servers',
];

function counts(db) {
  return Object.fromEntries(
    COUNTED_TABLES.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c,
    ]),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('IPv6 schema migrations 070-073', () => {
  it('upgrades a seeded 069 database through initDb without losing any child rows', async () => {
    const { db, tmpDir } = databaseThrough(69);
    seedTopology(db);
    const before = counts(db);
    db.close();

    process.env.DATA_DIR = tmpDir;
    await initDb(tmpDir);
    const upgraded = getDb();

    const after = counts(upgraded);
    // Startup seeds the two IPv6 option defaults (DNS servers 23, search
    // list 24); every other table keeps exactly its rows.
    expect(after).toEqual({ ...before, dhcp_option_defaults: before.dhcp_option_defaults + 2 });
    expect(
      upgraded
        .prepare(
          'SELECT option_code FROM dhcp_option_defaults WHERE address_family = 6 ORDER BY option_code',
        )
        .all()
        .map((row) => row.option_code),
    ).toEqual([23, 24]);
    expect(upgraded.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(78);

    const child = upgraded.prepare("SELECT * FROM subnets WHERE cidr = '10.70.0.0/24'").get();
    expect(child.address_family).toBe(4);
    expect(child.last_address).toBe('10.70.0.255');
    expect(child.broadcast_address).toBe('10.70.0.255');
    expect(child.parent_id).toBe(
      upgraded.prepare("SELECT id FROM subnets WHERE cidr = '10.70.0.0/23'").get().id,
    );

    const reservation = upgraded.prepare('SELECT * FROM dhcp_reservations').get();
    expect(reservation).toMatchObject({
      address_family: 4,
      mac_address: 'aa:bb:cc:dd:ee:01',
      duid: null,
      iaid: null,
    });
    const lease = upgraded.prepare('SELECT * FROM dhcp_leases').get();
    expect(lease).toMatchObject({ dhcp_version: 4, duid: null, iaid: null });
    expect(upgraded.prepare('SELECT address_family FROM dhcp_scopes').get().address_family).toBe(4);
    expect(upgraded.prepare('SELECT v6_mode FROM dhcp_scopes').get().v6_mode).toBeNull();
    for (const table of ['dhcp_scope_options', 'dhcp_option_defaults', 'dhcp_custom_options']) {
      expect(upgraded.prepare(`SELECT address_family FROM ${table}`).get().address_family).toBe(4);
    }

    // Migration 073: existing rogue rows are DHCPv4 findings and stay acknowledged.
    expect(upgraded.prepare('SELECT * FROM rogue_dhcp_events').get()).toMatchObject({
      kind: 'dhcp',
      address_family: 4,
      server_ip: '10.70.0.250',
      server_mac: '',
      server_duid: null,
      advertised_prefixes: null,
      acknowledged: 1,
    });
    expect(upgraded.prepare('SELECT * FROM dhcp_authorized_servers').get()).toMatchObject({
      server_ip: '10.70.0.2',
      server_mac: 'aa:bb:cc:dd:ee:03',
      server_duid: null,
    });

    // The widened schema accepts the IPv6 shapes.
    const v6 = upgraded
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
          total_addresses, status, depth, address_family, last_address)
         VALUES ('fd00:70::/64', 'lab6', 'fd00:70::', NULL, 64, NULL, 'allocated', 0, 6,
          'fd00:70::ffff:ffff:ffff:ffff')`,
      )
      .run().lastInsertRowid;
    upgraded
      .prepare(
        `INSERT INTO dhcp_reservations (subnet_id, ip_address, address_family, duid, iaid)
         VALUES (?, 'fd00:70::10', 6, '00:01:00:01:aa:bb:cc:dd', 42)`,
      )
      .run(v6);
    upgraded
      .prepare(
        `INSERT INTO dhcp_leases (ip_address, expires_at, subnet_id, dhcp_version, duid, iaid)
         VALUES ('fd00:70::1500', '2099-01-01T00:00:00.000Z', ?, 6, '00:01:00:01:aa:bb:cc:ee', 7)`,
      )
      .run(v6);
    const zone = upgraded.prepare("SELECT id FROM dns_zones WHERE name = 'lab.test'").get().id;
    upgraded
      .prepare(
        "INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, 'host6', 'AAAA', 'fd00:70::10')",
      )
      .run(zone);

    // And still refuses the shapes that make no sense.
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO dhcp_reservations (subnet_id, ip_address, address_family)
           VALUES (?, 'fd00:70::11', 6)`,
        )
        .run(v6),
    ).toThrow(/CHECK/);
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO dhcp_reservations (subnet_id, ip_address, address_family, duid)
           VALUES (?, '10.70.0.21', 4, '00:01')`,
        )
        .run(child.id),
    ).toThrow(/CHECK/);
    expect(() =>
      upgraded
        .prepare(
          "INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, 'x', 'NAPTR', 'y')",
        )
        .run(zone),
    ).toThrow(/CHECK/);

    // Foreign keys still cascade after the rebuild.
    upgraded.prepare('DELETE FROM subnets WHERE id = ?').run(child.id);
    expect(upgraded.prepare('SELECT COUNT(*) AS c FROM ranges').get().c).toBe(0);
    expect(
      upgraded.prepare('SELECT COUNT(*) AS c FROM dhcp_scopes WHERE subnet_id = ?').get(child.id).c,
    ).toBe(0);
  });

  it('would have emptied every child table under the old foreign-keys-on procedure', () => {
    const { db } = databaseThrough(69);
    seedTopology(db);
    const before = counts(db);
    const sql = fs.readFileSync(path.join(migrationsDir, '070_subnets_ipv6.sql'), 'utf8');
    db.transaction(() => db.exec(sql))();
    const after = counts(db);
    // The self-referencing parent_id cascades into the freshly copied table
    // too, so even the child network row is gone.
    expect(after.subnets).toBeLessThan(before.subnets);
    for (const table of [
      'ranges',
      'dhcp_scopes',
      'dhcp_reservations',
      'ip_addresses',
      'network_scans',
    ]) {
      expect(after[table], `${table} survives a foreign-keys-on rebuild`).toBe(0);
    }
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM dhcp_leases WHERE subnet_id IS NULL').get().c,
    ).toBe(before.dhcp_leases);
  });
});
