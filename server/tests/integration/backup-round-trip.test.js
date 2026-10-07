/**
 * Backup round trip: export with createBackup, change everything, restore
 * with restoreBackup, restart the way src/index.js boots, and the appliance
 * must be exactly what it was when the backup was taken. Every table is
 * compared, not a chosen few, so a new table is covered the day it lands.
 * The only differences allowed are the ones a restore promises to make: its
 * own audit row, the DHCP choice, the two-factor carry-over.
 *
 * A second case restores a backup taken at schema 54 (0.4.17) and lets the
 * restart migrate it forward.
 */
// First: the modules below read DATA_DIR when they load.
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanupTestDb } from '../helpers/test-db.js';
import { getDb, initDb } from '../../src/db/init.js';
import { BACKEND_RESTART_MARKER } from '../../src/config/defaults.js';

import {
  applyRestoreCarryover,
  collectRestoreCarryover,
  createBackup,
  getBackupPath,
  listBackups,
  restoreBackup,
  sweepStaleRestoreArtifacts,
} from '../../src/utils/backup.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const dataDir = DATA_DIR;

beforeAll(async () => {
  await initDb(dataDir);
  // The restore schedules the process exit that lets systemd restart it.
  vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  cleanupTestDb(dataDir);
});

// ─── What an appliance is ─────────────────────────────────────────────

function tables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

// Every row of every table, in a stable order.
function dumpTables(db) {
  return Object.fromEntries(
    tables(db).map((name) => [
      name,
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

// Every file the backup carries, by path, as a hash.
const CARRIED = ['certs', 'dnsmasq', 'analytics.duckdb', 'analytics.duckdb.wal', 'anomaly', 'kea'];
// Under a carried directory but not carried: Kea's control secret stays the
// host's, and its logs, sockets and rendered config belong to the running host.
const NOT_CARRIED = /^kea\/(secret|log|run)\/|^kea\/kea-dhcp[46]\.conf$/;
function hashFiles(root) {
  const out = {};
  const walk = (relative) => {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full)) walk(path.join(relative, name));
    } else if (!/\.(log|pid)$/.test(relative) && !NOT_CARRIED.test(relative)) {
      out[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  for (const entry of CARRIED) walk(entry);
  return out;
}

function writeFile(relative, content) {
  const full = path.join(dataDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// restoreBackup schedules the process exit that has systemd restart it.
// Run that timer here, against the stubbed exit, and check it asked for a
// clean restart.
function restoreAndExit(archive, options) {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const result = restoreBackup(archive, options);
    process.exit.mockClear();
    vi.runOnlyPendingTimers();
    expect(process.exit).toHaveBeenCalledWith(0);
    return result;
  } finally {
    vi.useRealTimers();
  }
}

// The restore swaps files and closes the database; the process then exits
// and systemd starts it again. This is that start (src/index.js).
async function restart() {
  await initDb(dataDir);
  const db = getDb();
  applyRestoreCarryover(db);
  sweepStaleRestoreArtifacts();
  return db;
}

// ─── A lived-in appliance ─────────────────────────────────────────────

function seed(db) {
  const folderId = db.prepare("INSERT INTO folders (name) VALUES ('Branch')").run().lastInsertRowid;
  const subnet = (cidr, name, network, broadcast, folder) =>
    Number(
      db
        .prepare(
          `INSERT INTO subnets
             (cidr, name, network_address, broadcast_address, prefix_length,
              total_addresses, status, depth, domain_name, folder_id)
           VALUES (?, ?, ?, ?, 24, 256, 'allocated', 0, 'round.test', ?)`,
        )
        .run(cidr, name, network, broadcast, folder).lastInsertRowid,
    );
  const lan = subnet('10.40.0.0/24', 'LAN', '10.40.0.0', '10.40.0.255', folderId);
  subnet('10.41.0.0/24', 'Lab', '10.41.0.0', '10.41.0.255', null);

  const zoneId = db
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('round.test', 'forward', 1)")
    .run().lastInsertRowid;
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
     VALUES (?, 'nas', 'A', '10.40.0.10', 'manual', 1),
            (?, 'old', 'A', '10.40.0.11', 'manual', 0),
            (?, 'files', 'CNAME', 'nas.round.test', 'manual', 1)`,
  ).run(zoneId, zoneId, zoneId);

  const scopeType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db
    .prepare(
      `INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
       VALUES (?, ?, '10.40.0.100', '10.40.0.199', 'Pool')`,
    )
    .run(lan, scopeType).lastInsertRowid;
  const scopeId = db
    .prepare('INSERT INTO dhcp_scopes (range_id, subnet_id, enabled) VALUES (?, ?, 1)')
    .run(rangeId, lan).lastInsertRowid;
  db.prepare(
    `INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
     VALUES (?, ?, '10.40.0.100', '10.40.0.199', 0)`,
  ).run(scopeId, rangeId);
  db.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, enabled)
     VALUES (?, '02:00:00:00:00:21', '10.40.0.21', 'printer', 1)`,
  ).run(lan);

  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('backup_retention_count', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
  const adminId = Number(
    db
      .prepare(
        "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('round-admin', 'hash', 'admin', 0)",
      )
      .run().lastInsertRowid,
  );

  writeFile('certs/server.crt', 'CERT v1');
  writeFile('certs/server.key', 'KEY v1');
  writeFile('dnsmasq/conf.d/cidrella.conf', 'domain=round.test\n');
  writeFile('dnsmasq/hosts.d/hosts', '10.40.0.10 nas\n');
  writeFile('dnsmasq/dnsmasq.leases', '0 02:00:00:00:00:30 10.40.0.130 laptop *\n');
  writeFile('analytics.duckdb', crypto.randomBytes(4096));
  writeFile('analytics.duckdb.wal', crypto.randomBytes(512));
  writeFile('anomaly/models/client-10.40.0.130.json', '{"trained":48}');
  writeFile('kea/kea-leases4.csv', 'address,hwaddr\n10.40.0.140,02:00:00:00:00:40\n');
  writeFile('kea/kea-leases6.csv', 'address,duid\nfd00:40::140,00:01:00:01\n');
  writeFile('kea/server-duid', '00:01:00:01:2e:aa:bb:cc:02:00:00:00:00:01\n');
  // Runtime files a backup must not carry.
  writeFile('dnsmasq/dnsmasq.log', 'query log\n'.repeat(100));
  writeFile('dnsmasq/dnsmasq.pid', '4242\n');
  writeFile('kea/secret/api-pw', 'secret v1');
  writeFile('kea/log/kea-dhcp4.log', 'kea log\n');
  writeFile('kea/log/kea-legal4.20261007.txt', 'legal\n');
  writeFile('kea/run/kea-dhcp4.pid', '4343\n');
  writeFile('kea/kea-dhcp4.conf', '{"Dhcp4":{}}');
  return { adminId };
}

// Everything a busy day after the backup might change.
function change(db, adminId) {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare("UPDATE subnets SET name = 'Renamed' WHERE cidr = '10.40.0.0/24'").run();
  db.prepare("INSERT INTO folders (name) VALUES ('After the backup')").run();
  db.prepare("UPDATE settings SET value = '9' WHERE key = 'backup_retention_count'").run();
  db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('later-user', 'hash', 'readonly', 0)",
  ).run();
  // The restoring admin turned two-factor on after the backup was taken.
  db.prepare(
    "UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1, totp_last_step = 7 WHERE id = ?",
  ).run(adminId);
  db.prepare("INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, 'code-hash-1')").run(
    adminId,
  );

  writeFile('certs/server.crt', 'CERT v2');
  writeFile('certs/extra.pem', 'added after the backup');
  writeFile('dnsmasq/conf.d/cidrella.conf', 'domain=changed.test\n');
  writeFile('analytics.duckdb', crypto.randomBytes(4096));
  fs.rmSync(path.join(dataDir, 'anomaly'), { recursive: true, force: true });
  writeFile('kea/kea-leases4.csv', 'address,hwaddr\n');
  writeFile('kea/secret/api-pw', 'secret v2');
}

// ─── The round trip ───────────────────────────────────────────────────

describe('backup round trip', () => {
  let adminId;
  let before;
  let beforeFiles;
  let backup;
  let after;

  beforeAll(async () => {
    ({ adminId } = seed(getDb()));
    // Boot once, so the appliance is as a running one would be (the startup
    // reconciles have given the DNS records their addresses).
    getDb().close();
    const db = await restart();
    before = dumpTables(db);
    beforeFiles = hashFiles(dataDir);

    backup = createBackup(db);

    change(db, adminId);
    // A second backup, taken after the changes: it must still be listed, and
    // counted for retention, once the older one is restored.
    const later = createBackup(db);
    backup.later = later.filename;

    // As POST /api/operations/restore calls it.
    const carryover = collectRestoreCarryover(db, adminId);
    restoreAndExit(getBackupPath(backup.filename), {
      dhcpAfterRestore: false,
      restoredBy: { username: 'round-admin' },
      carryover,
    });
    await restart();
    after = dumpTables(getDb());
  });

  it('brings back every table as it was, but for what a restore promises to change', () => {
    const promised = new Set(['audit_log', 'settings', 'users', 'user_backup_codes', 'backups']);
    for (const name of Object.keys(before)) {
      if (promised.has(name)) continue;
      expect(after[name], `table ${name}`).toEqual(before[name]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('changes the settings only by the DHCP choice', () => {
    const settings = (rows) =>
      Object.fromEntries(rows.map((row) => JSON.parse(row)).map((row) => [row.key, row.value]));
    const was = settings(before.settings);
    const is = settings(after.settings);
    expect(is.dhcp_enabled).toBe('false');
    expect(is.backup_retention_count).toBe('5');
    delete was.dhcp_enabled;
    delete is.dhcp_enabled;
    const stable = (rows) => Object.fromEntries(Object.entries(rows));
    expect(stable(is)).toEqual(stable(was));
  });

  it('keeps the users of the backup, with the restoring admin’s two-factor carried over', () => {
    const users = getDb().prepare('SELECT username, totp_enabled FROM users').all();
    expect(users.map((user) => user.username)).not.toContain('later-user');
    expect(users.find((user) => user.username === 'round-admin').totp_enabled).toBe(1);
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM user_backup_codes WHERE user_id = ?').get(adminId)
        .n,
    ).toBe(1);
  });

  it('adds the restore to the audit log and changes nothing else in it', () => {
    const rows = (list) => list.map((row) => JSON.parse(row));
    const added = rows(after.audit_log).filter(
      (row) => !before.audit_log.includes(JSON.stringify(row)),
    );
    expect(added.map((row) => row.action).sort()).toEqual(['restore', 'totp_carried_over']);
    expect(
      rows(before.audit_log).every((row) => after.audit_log.includes(JSON.stringify(row))),
    ).toBe(true);
  });

  it('brings back every carried file as it was, and drops what came after', () => {
    expect(hashFiles(dataDir)).toEqual(beforeFiles);
    expect(fs.existsSync(path.join(dataDir, 'certs/extra.pem'))).toBe(false);
  });

  it('carries no log or pid file', () => {
    expect(fs.existsSync(path.join(dataDir, 'dnsmasq/dnsmasq.log'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'dnsmasq/dnsmasq.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'kea/log'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'kea/run'))).toBe(false);
  });

  it('keeps the host’s Kea secret, and leaves the Kea config for boot to render', () => {
    expect(fs.readFileSync(path.join(dataDir, 'kea/secret/api-pw'), 'utf8')).toBe('secret v2');
    expect(fs.existsSync(path.join(dataDir, 'kea/kea-dhcp4.conf'))).toBe(false);
  });

  it('asks the next boot to restart every backend on what was restored', () => {
    expect(fs.existsSync(BACKEND_RESTART_MARKER)).toBe(true);
  });

  it('keeps a pre-restore snapshot and leaves no staging behind', () => {
    expect(fs.readdirSync(path.join(dataDir, 'snapshots', 'pre-restore')).length).toBeGreaterThan(
      0,
    );
    expect(fs.readdirSync(dataDir).filter((name) => name.startsWith('.restore-staging-'))).toEqual(
      [],
    );
  });

  // The backups table is restored with everything else, so it knows only the
  // backups taken before this one; the archives are still on disk.
  it('still lists every backup archive on disk', () => {
    const listed = listBackups(getDb()).map((row) => row.filename);
    expect(listed).toEqual(expect.arrayContaining([backup.filename, backup.later]));
  });
});

// ─── An older appliance ───────────────────────────────────────────────

describe('restoring a backup from schema 54', () => {
  let archive;

  beforeAll(async () => {
    // Build a 0.4.17 database in place of the current one, back it up, then
    // put a fresh current database back before restoring.
    getDb().close();
    const livePath = path.join(dataDir, 'cidrella.db');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(livePath + suffix, { force: true });
    const legacy = new Database(livePath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const apply = legacy.transaction((sql, version) => {
      legacy.exec(sql);
      legacy.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    for (const file of fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const version = Number.parseInt(file.split('_')[0], 10);
      if (version <= 54) apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
    }
    legacy.prepare("INSERT INTO folders (name) VALUES ('Legacy folder')").run();
    legacy
      .prepare(
        `INSERT INTO subnets
           (cidr, name, network_address, broadcast_address, prefix_length,
            total_addresses, status, depth, domain_name)
         VALUES ('10.50.0.0/24', 'Legacy LAN', '10.50.0.0', '10.50.0.255', 24, 256,
                 'allocated', 0, 'legacy.test')`,
      )
      .run();
    const zoneId = legacy
      .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('legacy.test', 'forward', 1)")
      .run().lastInsertRowid;
    legacy
      .prepare(
        `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
         VALUES (?, 'core', 'A', '10.50.0.5', 'manual', 1)`,
      )
      .run(zoneId);
    legacy
      .prepare(
        "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('legacy-admin', 'hash', 'admin', 0)",
      )
      .run();

    archive = createBackup(legacy);
    legacy.close();
    expect(archive.schema_version).toBe(54);

    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(livePath + suffix, { force: true });
    await initDb(dataDir);
    restoreAndExit(getBackupPath(archive.filename), {
      restoredBy: { username: 'legacy-admin' },
    });
    await restart();
  });

  it('migrates the restored database to the current schema', () => {
    const latest = Math.max(
      ...fs
        .readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => Number.parseInt(name.split('_')[0], 10)),
    );
    expect(getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(latest);
  });

  it('keeps the old appliance’s data through the migrations', () => {
    const db = getDb();
    expect(
      db
        .prepare('SELECT name FROM folders')
        .all()
        .map((row) => row.name),
    ).toEqual(['Legacy folder']);
    expect(db.prepare('SELECT cidr, name, domain_name FROM subnets').all()).toEqual([
      { cidr: '10.50.0.0/24', name: 'Legacy LAN', domain_name: 'legacy.test' },
    ]);
    expect(
      db
        .prepare(
          'SELECT z.name AS zone, r.name, r.type, r.value FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id',
        )
        .all(),
    ).toEqual([{ zone: 'legacy.test', name: 'core', type: 'A', value: '10.50.0.5' }]);
    expect(
      db
        .prepare('SELECT username FROM users')
        .all()
        .map((row) => row.username),
    ).toContain('legacy-admin');
    // The restart's reconcile gives the served record its address.
    expect(
      db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.50.0.5'").get(),
    ).toMatchObject({ allocation_state: 'static_dns' });
  });

  it('records the restore in the migrated audit log', () => {
    const row = getDb()
      .prepare("SELECT details FROM audit_log WHERE action = 'restore' ORDER BY id DESC")
      .get();
    expect(JSON.parse(row.details)).toMatchObject({
      restored_by: 'legacy-admin',
      backup_schema_version: 54,
    });
  });
});

// ─── Two backups in one second ────────────────────────────────────────

describe('two backups in the same second', () => {
  it('keeps both archives, listed under their own names', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T08:00:00.250Z'));
    try {
      const db = getDb();
      const first = createBackup(db);
      vi.setSystemTime(new Date('2026-09-29T08:00:00.750Z'));
      const second = createBackup(db);
      expect(second.filename).not.toBe(first.filename);
      for (const { filename } of [first, second]) {
        expect(fs.existsSync(getBackupPath(filename))).toBe(true);
      }
      expect(listBackups(db).map((row) => row.filename)).toEqual(
        expect.arrayContaining([first.filename, second.filename]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
