/**
 * Migration 082 (DNS-NAME-01): record names follow the zone-file rule. A
 * dotted name without a trailing dot used to be served as absolute; the
 * migration adds the dot so it keeps serving the same name, and trims the dot
 * from the copies an absolute name left in the address hostname and in
 * generated PTR values.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fqdnForRecordName } from '../../src/models/dns-record.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];
const files = fs
  .readdirSync(migrationsDir)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const versionOf = (f) => Number.parseInt(f.split('_')[0], 10);

function migrate(db, from, to) {
  for (const f of files) {
    const v = versionOf(f);
    if (v <= from || v > to) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
  }
}

function databaseThrough(target) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-dnsabs-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  migrate(db, 0, target);
  return db;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function seed(db) {
  const zone = (name, type) =>
    db.prepare('INSERT INTO dns_zones (name, type, enabled) VALUES (?, ?, 1)').run(name, type)
      .lastInsertRowid;
  const fwd = zone('example.lan', 'forward');
  const rev4 = zone('0.10.in-addr.arpa', 'reverse');
  const record = (zoneId, name, type, value, source = 'manual') =>
    db
      .prepare(
        'INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(zoneId, name, type, value, source).lastInsertRowid;
  const ids = {
    v4Outside: record(fwd, 'nas.home.lan', 'A', '10.0.0.5'),
    v6Outside: record(fwd, 'nas.home.lan', 'AAAA', 'fd00::5'),
    alreadyAbsolute: record(fwd, 'ext.org.', 'A', '10.0.0.6'),
    relative: record(fwd, 'www', 'A', '10.0.0.7'),
    srv: record(fwd, '_sip._tcp', 'SRV', 'pbx.example.lan'),
    ptrName: record(rev4, '5.0', 'PTR', 'nas.home.lan'),
    generatedPtr: record(rev4, '6.0', 'PTR', 'ext.org.', 'dns'),
    manualPtr: record(rev4, '8.0', 'PTR', 'mine.example.org.'),
  };

  const subnet = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, gateway_address, domain_name)
       VALUES ('10.0.0.0/24', 'n', '10.0.0.0', '10.0.0.255', 24, 256, '10.0.0.1', 'example.lan')`,
    )
    .run().lastInsertRowid;
  const address = db.prepare(
    `INSERT INTO ip_addresses (subnet_id, ip_address, hostname, detection_source, allocation_state,
       allocation_source_type, allocation_source_id, address_family, address_sort_key)
     VALUES (?, ?, ?, 'topology', 'system', 'topology', ?, ?, ?)`,
  );
  address.run(subnet, '10.0.0.6', 'ext.org.', subnet, 4, '4:0a000006');
  address.run(subnet, 'fd00::6', 'ext6.org.', subnet, 6, '6:fd000000000000000000000000000006');
  address.run(subnet, '10.0.0.7', 'www.example.lan', subnet, 4, '4:0a000007');
  return ids;
}

describe('migration 082', () => {
  it('keeps every record serving the name it served before', () => {
    const db = databaseThrough(81);
    seed(db);
    // What each forward record served under the old rule (a dotted name was
    // absolute; SRV is the exception 0.5.1 already made).
    const oldFqdn = (name, zone, type) => {
      const n = name.replace(/\.$/, '');
      if (type === 'SRV' || !n.includes('.')) return `${n}.${zone}`;
      return n;
    };
    const forward = () =>
      db
        .prepare(
          `SELECT r.id, r.name, r.type, z.name AS zone FROM dns_records r
           JOIN dns_zones z ON z.id = r.zone_id WHERE z.type = 'forward' ORDER BY r.id`,
        )
        .all();
    const before = new Map(forward().map((r) => [r.id, oldFqdn(r.name, r.zone, r.type)]));

    migrate(db, 81, 82);

    for (const r of forward()) {
      expect(fqdnForRecordName(r.name, r.zone), `${r.type} ${r.name}`).toBe(before.get(r.id));
    }
  });

  it('marks dotted out-of-zone names absolute and leaves the rest alone', () => {
    const db = databaseThrough(81);
    const ids = seed(db);
    migrate(db, 81, 82);
    const name = (id) => db.prepare('SELECT name FROM dns_records WHERE id = ?').get(id).name;
    expect(name(ids.v4Outside)).toBe('nas.home.lan.');
    expect(name(ids.v6Outside)).toBe('nas.home.lan.');
    expect(name(ids.alreadyAbsolute)).toBe('ext.org.');
    expect(name(ids.relative)).toBe('www');
    expect(name(ids.srv)).toBe('_sip._tcp');
    expect(name(ids.ptrName)).toBe('5.0');
  });

  it('trims the dot from derived hostnames and generated PTR values, not operator PTRs', () => {
    const db = databaseThrough(81);
    const ids = seed(db);
    migrate(db, 81, 82);
    const host = (ip) =>
      db.prepare('SELECT hostname FROM ip_addresses WHERE ip_address = ?').get(ip).hostname;
    expect(host('10.0.0.6')).toBe('ext.org');
    expect(host('fd00::6')).toBe('ext6.org');
    expect(host('10.0.0.7')).toBe('www.example.lan');
    const value = (id) => db.prepare('SELECT value FROM dns_records WHERE id = ?').get(id).value;
    expect(value(ids.generatedPtr)).toBe('ext.org');
    expect(value(ids.manualPtr)).toBe('mine.example.org.');
    expect(value(ids.ptrName)).toBe('nas.home.lan');
  });
});
