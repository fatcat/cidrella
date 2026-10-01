/**
 * Generated PTRs are served from the hosts file, not ptr-record lines, so a
 * renamed host changes hosts.d (reloaded without a restart) and leaves conf.d
 * (which costs a dnsmasq restart) alone. dnsmasq answers a reverse lookup
 * from the first hosts line for an address, and a ptr-record beats a hosts
 * line; both were checked against dnsmasq 2.91.
 */
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

let tmpDir;
let db;
let regenerateHostsDir;
let regenerateConfDir;
let forwardId;
let reverseId;

const read = (...parts) => fs.readFileSync(path.join(DATA_DIR, 'dnsmasq', ...parts), 'utf-8');
const add = (zoneId, name, type, value) =>
  db
    .prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, ?, ?, 'manual', 1)",
    )
    .run(zoneId, name, type, value).lastInsertRowid;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  ({ regenerateHostsDir, regenerateConfDir } = await import('../../src/utils/dnsmasq.js'));
  forwardId = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)")
    .run().lastInsertRowid;
  reverseId = db
    .prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('1.0.10.in-addr.arpa', 'reverse', 1)",
    )
    .run().lastInsertRowid;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('hosts.d serves the generated PTRs', () => {
  it('orders each address canonical name first and keeps served PTRs out of conf.d', () => {
    // Two names on one address; reverse-DNS projection chose the second.
    add(forwardId, 'alpha', 'A', '10.0.1.10');
    add(forwardId, 'beta', 'A', '10.0.1.10');
    add(reverseId, '10', 'PTR', 'beta.example.test');
    // An operator override pointing somewhere no A record does.
    add(forwardId, 'gamma', 'A', '10.0.1.11');
    add(reverseId, '11', 'PTR', 'custom.elsewhere.net');
    // A PTR-only name.
    add(reverseId, '12', 'PTR', 'printer.example.test');
    // A zone of its own: one file holds every zone, so cross-zone order holds.
    const lab = db
      .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('lab.test', 'forward', 1)")
      .run().lastInsertRowid;
    add(lab, 'delta', 'A', '10.0.1.9');

    regenerateHostsDir(db);
    regenerateConfDir(db);

    expect(read('hosts.d', 'records.hosts')).toBe(
      [
        '10.0.1.9 delta.lab.test',
        '10.0.1.10 beta.example.test',
        '10.0.1.10 alpha.example.test',
        '10.0.1.11 gamma.example.test',
        '',
      ].join('\n'),
    );
    const conf = read('conf.d', `zone-${reverseId}.conf`);
    expect(conf).not.toContain('10.1.0.10.in-addr.arpa');
    expect(conf).toContain('ptr-record=11.1.0.10.in-addr.arpa,custom.elsewhere.net');
    expect(conf).toContain('ptr-record=12.1.0.10.in-addr.arpa,printer.example.test');
  });

  it('renames a host through hosts.d alone, with no conf.d change to restart for', () => {
    // What the DHCP sync does when a lease's name changes: A and PTR move together.
    db.prepare(
      "UPDATE dns_records SET name = 'beta2' WHERE zone_id = ? AND name = 'beta' AND type = 'A'",
    ).run(forwardId);
    db.prepare(
      "UPDATE dns_records SET value = 'beta2.example.test' WHERE zone_id = ? AND name = '10' AND type = 'PTR'",
    ).run(reverseId);

    expect(regenerateHostsDir(db)).toBe(true);
    expect(regenerateConfDir(db)).toBe(false);
    expect(read('hosts.d', 'records.hosts')).toContain(
      '10.0.1.10 beta2.example.test\n10.0.1.10 alpha.example.test',
    );
  });

  it('replaces the per-zone hosts files of earlier releases', () => {
    fs.writeFileSync(path.join(DATA_DIR, 'dnsmasq', 'hosts.d', `zone-${forwardId}.hosts`), 'old\n');
    expect(regenerateHostsDir(db)).toBe(true);
    expect(fs.readdirSync(path.join(DATA_DIR, 'dnsmasq', 'hosts.d'))).toEqual(['records.hosts']);
  });
});
