/**
 * Migration 086 (DHCP-01): a default option reaches a scope only through a
 * linked row now, so the migration links every scope to each default it was
 * being served. The promise is that no scope serves anything different after
 * the upgrade. Until 086 a scope got every default with a value, overlaid by
 * its own rows, the legacy scope columns and the network; the expectations
 * below are what that served, written out.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveEffectiveScopeOptions } from '../../src/models/dhcp-scope.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const MIGRATION = 86;
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function migrations(test) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && test(Number.parseInt(name, 10)))
    .sort()
    .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
}

function databaseBefore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-option-links-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  for (const sql of migrations((version) => version < MIGRATION)) db.exec(sql);
  return db;
}

function subnet(db, { cidr, network, broadcast, prefix, gateway = null, domain }) {
  return db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, status, depth, domain_name, address_family)
       VALUES (?, ?, ?, ?, ?, 256, ?, 'allocated', 0, ?, ?)`,
    )
    .run(cidr, cidr, network, broadcast, prefix, gateway, domain, cidr.includes(':') ? 6 : 4)
    .lastInsertRowid;
}

function scope(db, subnetId, start, end, columns = {}) {
  const rangeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const range = db
    .prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, ?, ?)')
    .run(subnetId, rangeType, start, end).lastInsertRowid;
  const family = start.includes(':') ? 6 : 4;
  return db
    .prepare(
      `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode,
        gateway, domain_name, ntp_servers, dns_servers, domain_search)
       VALUES (?, ?, '1h', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      range,
      subnetId,
      family,
      columns.v6_mode ?? (family === 6 ? 'stateful' : null),
      columns.gateway ?? null,
      columns.domain_name ?? null,
      columns.ntp_servers ?? null,
      columns.dns_servers ?? null,
      columns.domain_search ?? null,
    ).lastInsertRowid;
}

function own(db, scopeId, code, value, family) {
  db.prepare(
    'INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, ?, ?, ?)',
  ).run(scopeId, code, value, family);
}

function served(db, scopeId) {
  const row = db
    .prepare(
      `SELECT s.*, sub.cidr AS subnet_cidr, sub.gateway_address AS subnet_gateway,
         sub.domain_name AS subnet_domain_name
       FROM dhcp_scopes s JOIN subnets sub ON sub.id = s.subnet_id WHERE s.id = ?`,
    )
    .get(scopeId);
  return Object.fromEntries(
    resolveEffectiveScopeOptions(db, row).options.map((o) => [o.option_code, o.value]),
  );
}

describe('migration 086: linked default options', () => {
  it('keeps what every scope serves, IPv4 and IPv6', () => {
    const db = databaseBefore();
    db.prepare('DELETE FROM dhcp_option_defaults').run();
    db.prepare(
      `INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, address_family)
       VALUES (6, '10.0.0.53', 1, 4), (42, '10.0.0.123', 0, 4), (66, 'tftp.test', 0, 4),
         (51, '12h', 1, 4), (150, NULL, 1, 4),
         (56, 'fd00::123', 1, 6), (32, '7200', 0, 6)`,
    ).run();

    // IPv4 with rows of its own: its DNS beats the default.
    const a = scope(
      db,
      subnet(db, {
        cidr: '10.80.1.0/24',
        network: '10.80.1.0',
        broadcast: '10.80.1.255',
        prefix: 24,
        gateway: '10.80.1.1',
        domain: 'a.test',
      }),
      '10.80.1.100',
      '10.80.1.200',
    );
    own(db, a, 6, '10.80.1.53', 4);
    // IPv4 with no rows: the legacy columns serve NTP over the default.
    const b = scope(
      db,
      subnet(db, {
        cidr: '10.80.2.0/24',
        network: '10.80.2.0',
        broadcast: '10.80.2.255',
        prefix: 24,
        gateway: '10.80.2.1',
        domain: 'b.test',
      }),
      '10.80.2.100',
      '10.80.2.200',
      { ntp_servers: '["10.80.2.9"]' },
    );
    // IPv6 whose row was copied as family 4 (the divide/merge copy bug), with
    // a legacy DNS column.
    const c = scope(
      db,
      subnet(db, {
        cidr: 'fd80:c::/64',
        network: 'fd80:c::',
        broadcast: 'fd80:c::',
        prefix: 64,
        domain: 'c.test',
      }),
      'fd80:c::1000',
      'fd80:c::1fff',
      { dns_servers: '["fd80:c::53"]' },
    );
    own(db, c, 24, 'own.test', 4);
    const d = scope(
      db,
      subnet(db, {
        cidr: 'fd80:d::/64',
        network: 'fd80:d::',
        broadcast: 'fd80:d::',
        prefix: 64,
        domain: 'd.test',
      }),
      'fd80:d::',
      'fd80:d::',
      { v6_mode: 'slaac' },
    );

    const expected = {
      [a]: {
        1: '255.255.255.0',
        3: '10.80.1.1',
        6: '10.80.1.53',
        15: 'a.test',
        28: '10.80.1.255',
        42: '10.0.0.123',
        66: 'tftp.test',
        119: 'a.test',
      },
      [b]: {
        1: '255.255.255.0',
        3: '10.80.2.1',
        6: '10.0.0.53',
        15: 'b.test',
        28: '10.80.2.255',
        42: '10.80.2.9',
        66: 'tftp.test',
        119: 'b.test',
      },
      [c]: { 23: 'fd80:c::53', 24: 'own.test', 32: '7200', 56: 'fd00::123' },
      [d]: { 24: 'd.test', 32: '7200', 56: 'fd00::123' },
    };

    for (const sql of migrations((version) => version === MIGRATION)) db.exec(sql);

    for (const id of [a, b, c, d]) expect(served(db, id), `scope ${id}`).toEqual(expected[id]);

    const rows = db
      .prepare(
        'SELECT scope_id, option_code, value, address_family FROM dhcp_scope_options ORDER BY scope_id, option_code',
      )
      .all();
    expect(rows).toEqual([
      { scope_id: a, option_code: 6, value: '10.80.1.53', address_family: 4 },
      { scope_id: a, option_code: 42, value: null, address_family: 4 },
      { scope_id: a, option_code: 66, value: null, address_family: 4 },
      { scope_id: b, option_code: 6, value: null, address_family: 4 },
      { scope_id: b, option_code: 42, value: null, address_family: 4 },
      { scope_id: b, option_code: 66, value: null, address_family: 4 },
      { scope_id: c, option_code: 24, value: 'own.test', address_family: 6 },
      { scope_id: c, option_code: 32, value: null, address_family: 6 },
      { scope_id: c, option_code: 56, value: null, address_family: 6 },
      { scope_id: d, option_code: 32, value: null, address_family: 6 },
      { scope_id: d, option_code: 56, value: null, address_family: 6 },
    ]);

    // Linked from here on: an edit of the default reaches the scope.
    db.prepare(
      "UPDATE dhcp_option_defaults SET value = '10.0.0.124' WHERE option_code = 42 AND address_family = 4",
    ).run();
    expect(served(db, a)[42]).toBe('10.0.0.124');
    db.close();
  });
});
