/**
 * The change log, end to end on one machine: writes of every kind on one
 * database (models, raw SQL, a second connection), exported and applied to
 * another, which must then hold the same data of record, table by table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { applyChanges, exportChanges, parseChanges, SyncError } =
  await import('../../src/sync/changes.js');
const {
  dropSyncTriggers,
  ensureSyncLog,
  ensureSyncTriggers,
  estateTables,
  forgetDataset,
  pruneTombstones,
  syncStatus,
} =
  await import('../../src/sync/log.js');
const { replaceLeases } = await import('../../src/models/dhcp-lease.js');
const { recordAudit } = await import('../../src/services/audit.js');
const { setSetting } = await import('../../src/db/init.js');

let source;
let sourceDir;
const tmpDirs = [];
beforeAll(async () => {
  ({ db: source, tmpDir: sourceDir } = await setupTestDb());
  enableIpv6(source);
});
afterAll(() => {
  cleanupTestDb(sourceDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** An empty database at the same schema, as a member's is before its first sync. */
function emptyCopy() {
  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  return { db, dir: tmpDir };
}

/** The data of record of `db`: every estate table's estate rows and columns, in key order. */
function estate(db) {
  return Object.fromEntries(
    estateTables(db).map((table) => [
      table.name,
      db
        .prepare(
          `SELECT ${table.columns.join(', ')} FROM ${table.name} AS r
           WHERE ${table.isEstateRow('r')} ORDER BY ${table.key}`,
        )
        .all(),
    ]),
  );
}

function expectSame(copy) {
  const want = estate(source);
  const got = estate(copy);
  for (const name of Object.keys(want)) expect(got[name], `table ${name}`).toEqual(want[name]);
}

/** Bring `copy` up to the source's head. Returns what applyChanges did. */
function sync(copy) {
  const { dataset } = syncStatus(copy.db);
  const cursor = copy.db.prepare("SELECT value FROM sync_state WHERE key = 'cursor'").get();
  const payload = exportChanges(source, { dataset, since: cursor ? Number(cursor.value) : null });
  return applyChanges(copy.db, parseChanges(payload));
}

// A small seeded generator, so a failure repeats.
function prng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** One random write on `db`. Every statement is valid on any state the others leave. */
function randomWrite(db, random, n) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const anyId = (table) =>
    db.prepare(`SELECT id FROM ${table} ORDER BY random() LIMIT 1`).get()?.id ?? null;
  const writes = [
    () => db.prepare('INSERT INTO folders (name) VALUES (?)').run(`folder-${n}`),
    () => db.prepare('UPDATE folders SET description = ? WHERE id = ?').run(`d${n}`, anyId('folders')),
    // Deleting a folder sets folder_id to NULL on its zones, networks and VLANs.
    () => db.prepare('DELETE FROM folders WHERE id = ?').run(anyId('folders')),
    () =>
      db
        .prepare("INSERT INTO dns_zones (name, type, folder_id) VALUES (?, 'forward', ?)")
        .run(`zone-${n}.test`, anyId('folders')),
    // Deleting a zone takes its records with it.
    () => db.prepare('DELETE FROM dns_zones WHERE id = ?').run(anyId('dns_zones')),
    () => {
      const zone = anyId('dns_zones');
      if (!zone) return;
      const v6 = random() < 0.5;
      db.prepare('INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, ?, ?, ?)').run(
        zone,
        `host-${n}`,
        v6 ? 'AAAA' : 'A',
        v6 ? `2001:db8:${n.toString(16)}::1` : `10.20.${n % 250}.${(n * 7) % 250}`,
      );
    },
    () => db.prepare('UPDATE dns_records SET ttl = ? WHERE id = ?').run(60 + n, anyId('dns_records')),
    () => db.prepare('DELETE FROM dns_records WHERE id = ?').run(anyId('dns_records')),
    // The same value again: not a change, and it must not be sent as one.
    () => db.prepare('UPDATE dns_records SET enabled = enabled WHERE id = ?').run(anyId('dns_records')),
    () =>
      db
        .prepare('INSERT OR IGNORE INTO geoip_rules (country_code, country_name) VALUES (?, ?)')
        .run(pick(['AA', 'BB', 'CC', 'DD']), `country-${n}`),
    // UPDATE OR IGNORE: a collision on the unique code leaves the row as it was.
    () =>
      db
        .prepare('UPDATE OR IGNORE geoip_rules SET country_code = ? WHERE id = ?')
        .run(pick(['AA', 'BB', 'CC', 'DD', 'EE']), anyId('geoip_rules')),
    // Two rows swap a unique value inside one transaction.
    () => {
      const [a, b] = db.prepare('SELECT id, country_code FROM geoip_rules LIMIT 2').all();
      if (!b) return;
      db.transaction(() => {
        const set = db.prepare('UPDATE geoip_rules SET country_code = ? WHERE id = ?');
        set.run('ZZ', a.id);
        set.run(a.country_code, b.id);
        set.run(b.country_code, a.id);
      })();
    },
    () => db.prepare('DELETE FROM geoip_rules WHERE id = ?').run(anyId('geoip_rules')),
    // An estate setting and a host one: only the first is data of record.
    () => setSettingOn(db, 'map_home', `${n},${n}`),
    () => setSettingOn(db, 'backup_last_run', `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`),
    // A category's switch is shared; what this box fetched of it is not.
    () =>
      db
        .prepare(
          `INSERT INTO blocklist_categories (slug, enabled, source_url) VALUES (?, 1, ?)
           ON CONFLICT(slug) DO UPDATE SET enabled = 1 - enabled`,
        )
        .run(pick(['ads', 'malware', 'custom']), `https://lists.test/${n}.txt`),
    () =>
      db
        .prepare('UPDATE blocklist_categories SET domain_count = ?, etag = ? WHERE slug = ?')
        .run(n, `etag-${n}`, pick(['ads', 'malware', 'custom'])),
    () =>
      db
        .prepare(
          `INSERT INTO device_fingerprints (mac_address, device_type) VALUES (?, ?)
           ON CONFLICT(mac_address) DO UPDATE SET device_type = excluded.device_type`,
        )
        .run(`aa:bb:cc:00:00:${(n % 5).toString(16).padStart(2, '0')}`, pick(['Phone', 'Printer'])),
    () => db.prepare('DELETE FROM device_fingerprints WHERE rowid = (SELECT min(rowid) FROM device_fingerprints)').run(),
  ];
  pick(writes)();
}

const setSettingOn = (db, key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

describe('change log loopback', () => {
  let copy;

  it('brings an empty database to the same data of record from a snapshot', () => {
    for (let n = 0; n < 60; n++) randomWrite(source, prng(n + 1), n);
    copy = emptyCopy();
    const result = sync(copy);
    expect(result.snapshot).toBe(true);
    expectSame(copy.db);
    expect(syncStatus(copy.db).dataset).toBe(syncStatus(source).dataset);
  });

  it('follows random writes with deltas, and mirrors the log', () => {
    const random = prng(20261121);
    const from = syncStatus(source).head;
    for (let round = 0; round < 12; round++) {
      for (let n = 0; n < 25; n++) randomWrite(source, random, 1000 + round * 25 + n);
      const result = sync(copy);
      expect(result.snapshot).toBe(false);
      expectSame(copy.db);
    }
    const log = (db) =>
      db.prepare('SELECT seq, tbl, pk, op FROM sync_log WHERE seq > ? ORDER BY seq').all(from);
    expect(log(copy.db)).toEqual(log(source));
    expect(syncStatus(copy.db).head).toBe(syncStatus(source).head);
  });

  it('sends nothing for a write that changed nothing, or one to host data', () => {
    const before = syncStatus(source).head;
    source.prepare('UPDATE dns_zones SET enabled = enabled').run();
    setSettingOn(source, 'backup_last_run', 'again');
    source.prepare("UPDATE blocklist_categories SET domain_count = domain_count + 1, etag = 'x'").run();
    expect(syncStatus(source).head).toBe(before);
    expect(sync(copy).rows).toBe(0);
  });

  it('keeps what the copy fetched of a blocklist when the list’s switch changes', () => {
    setSettingOn(source, 'map_home', 'reset');
    source.prepare("INSERT OR IGNORE INTO blocklist_categories (slug, enabled) VALUES ('ads', 1)").run();
    sync(copy);
    copy.db.prepare("UPDATE blocklist_categories SET domain_count = 4242 WHERE slug = 'ads'").run();
    source.prepare("UPDATE blocklist_categories SET enabled = 1 - enabled WHERE slug = 'ads'").run();
    sync(copy);
    expect(
      copy.db.prepare("SELECT domain_count FROM blocklist_categories WHERE slug = 'ads'").get()
        .domain_count,
    ).toBe(4242);
    expectSame(copy.db);
  });

  it('sees writes made through the models and by a second connection', () => {
    recordAudit({ action: 'loopback_tested', entityType: 'test', details: { n: 1 } });
    setSetting('map_home', '10,20');
    const subnet = source
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
           total_addresses, status) VALUES ('10.77.0.0/24', 'loop', '10.77.0.0', '10.77.0.255', 24, 256, 'allocated')`,
      )
      .run().lastInsertRowid;
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    replaceLeases(source, [
      { ip: '10.77.0.10', mac: 'aa:bb:cc:77:00:10', hostname: 'four', expiresAt: inAnHour, subnetId: subnet },
      {
        ip: '2001:db8:77::10',
        hostname: 'six',
        expiresAt: inAnHour,
        subnetId: null,
        dhcpVersion: 6,
        duid: '00:01:00:01:00:00:00:77',
        iaid: 1,
      },
    ], { lifecycleValidated: true });
    // As the anomaly sidecar writes: its own connection, plain SQL.
    const second = new Database(path.join(sourceDir, 'cidrella.db'));
    second.prepare("INSERT INTO anomaly_allowlist (identity, client_ip, reason) VALUES ('m1', '10.77.0.10', 'loop')").run();
    second.close();

    const result = sync(copy);
    expect(result.tables).toEqual(
      expect.arrayContaining(['audit_log', 'settings', 'subnets', 'dhcp_leases', 'anomaly_allowlist']),
    );
    expectSame(copy.db);
    expect(copy.db.prepare('SELECT ip_address FROM dhcp_leases ORDER BY ip_address').all()).toEqual([
      { ip_address: '10.77.0.10' },
      { ip_address: '2001:db8:77::10' },
    ]);
  });

  it('follows a delete that cascades', () => {
    const zone = source.prepare("INSERT INTO dns_zones (name, type) VALUES ('cascade.test', 'forward')").run().lastInsertRowid;
    const add = source.prepare("INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, ?, 'A', ?)");
    for (let i = 1; i <= 5; i++) add.run(zone, `c${i}`, `10.88.0.${i}`);
    sync(copy);
    source.prepare('DELETE FROM dns_zones WHERE id = ?').run(zone);
    const result = sync(copy);
    expect(result.rows).toBe(6);
    expect(copy.db.prepare('SELECT count(*) n FROM dns_records WHERE zone_id = ?').get(zone).n).toBe(0);
    expectSame(copy.db);
  });

  it('logs again after a migration rebuilt a table and dropped its triggers', () => {
    source.exec('DROP TRIGGER sync_log_folders_ai; DROP TRIGGER sync_log_folders_au');
    expect(ensureSyncTriggers(source)).toBe(2);
    expect(ensureSyncTriggers(source)).toBe(0);
    source.prepare("INSERT INTO folders (name) VALUES ('after-rebuild')").run();
    sync(copy);
    expectSame(copy.db);
  });

  it('refuses a delta that does not follow on, and one for another schema', () => {
    const status = syncStatus(source);
    source.prepare("INSERT INTO folders (name) VALUES ('ahead')").run();
    const stale = parseChanges(exportChanges(source, { dataset: status.dataset, since: status.head }));
    sync(copy);
    // The same delta again: the copy is past where it starts.
    expect(() => applyChanges(copy.db, stale)).toThrow(SyncError);
    try {
      applyChanges(copy.db, stale);
    } catch (err) {
      expect(err.code).toBe('restart');
    }
    const other = { header: { ...stale.header, schema: stale.header.schema + 1 }, changes: [] };
    expect(() => applyChanges(copy.db, other)).toThrow(/schema/);
    expectSame(copy.db);
  });

  it('refuses changes that arrived damaged, and changes nothing', () => {
    source.prepare("INSERT INTO folders (name) VALUES ('damaged')").run();
    const status = syncStatus(copy.db);
    const cursor = Number(copy.db.prepare("SELECT value FROM sync_state WHERE key = 'cursor'").get().value);
    const payload = exportChanges(source, { dataset: status.dataset, since: cursor });
    const flipped = Buffer.from(payload);
    flipped[Math.floor(flipped.length / 2)] ^= 1;
    expect(() => parseChanges(flipped)).toThrow(/damaged/);
    expect(() => parseChanges(payload.subarray(0, payload.length - 20))).toThrow(/damaged/);
    applyChanges(copy.db, parseChanges(payload));
    expectSame(copy.db);
  });

  it('gives a copy behind the pruned tombstones a snapshot', () => {
    const behind = emptyCopy();
    sync(behind);
    const victim = source.prepare("INSERT INTO folders (name) VALUES ('to-go')").run().lastInsertRowid;
    sync(copy);
    source.prepare('DELETE FROM folders WHERE id = ?').run(victim);
    // Every copy the owner knows of has taken the delete: only `copy` counts here.
    sync(copy);
    expect(pruneTombstones(source)).toBeGreaterThan(0);
    expect(source.prepare("SELECT count(*) n FROM sync_log WHERE op = 'd'").get().n).toBe(0);

    // `behind` never saw the folder go; its cursor is under the floor now.
    const result = sync(behind);
    expect(result.snapshot).toBe(true);
    expectSame(behind.db);
    // `copy` is at the head and carries on with deltas.
    source.prepare("INSERT INTO folders (name) VALUES ('after-prune')").run();
    expect(sync(copy).snapshot).toBe(false);
    expectSame(copy.db);
  });

  it('starts a new dataset when the database is not the one the log described', () => {
    const before = syncStatus(source);
    // The same database booting again, twice: nothing starts.
    expect(ensureSyncLog(source, sourceDir).started).toBe(null);
    expect(ensureSyncLog(source, sourceDir).started).toBe(null);
    // A rolled-back update puts back the database file from before this
    // boot, with the token of an earlier one; the token beside it is newer.
    source.prepare("UPDATE sync_state SET value = 'an-earlier-boot' WHERE key = 'incarnation'").run();
    expect(ensureSyncLog(source, sourceDir).started).toBe('database replaced');
    const after = syncStatus(source);
    expect(after.dataset).not.toBe(before.dataset);
    expect(after.floor).toBe(after.head);
    expect(source.prepare('SELECT count(*) n FROM sync_log').get().n).toBe(0);

    // A copy of the old dataset is given a snapshot, whatever its cursor.
    source.prepare("INSERT INTO folders (name) VALUES ('new-dataset')").run();
    const result = sync(copy);
    expect(result.snapshot).toBe(true);
    expectSame(copy.db);
    expect(syncStatus(copy.db).dataset).toBe(after.dataset);

    // A restore marks the database it brings in.
    forgetDataset(source);
    expect(ensureSyncLog(source, sourceDir).started).toBe('first run');
    expect(syncStatus(source).dataset).not.toBe(after.dataset);
  });

  it('starts a new dataset after a migration', () => {
    source.prepare("UPDATE sync_state SET value = '1' WHERE key = 'schema'").run();
    dropSyncTriggers(source);
    expect(ensureSyncLog(source, sourceDir).started).toBe('schema changed');
    expect(source.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'sync_log_%' AND type = 'trigger'").get().n)
      .toBe(estateTables(source).length * 3);
  });

  it('keeps the triggers a copy had on its tables', () => {
    const triggers = (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    const had = triggers(copy.db);
    expect(had.length).toBeGreaterThan(0);
    source.prepare("INSERT INTO folders (name) VALUES ('triggers')").run();
    sync(copy);
    expect(triggers(copy.db)).toEqual(had);
    expect(copy.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
