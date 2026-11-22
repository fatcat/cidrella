/**
 * A restore on a box that has instances (sync/restore.js). The backup brings
 * the data back; the instance list, the epoch and which instance serves DHCP
 * stay the running box's, because they describe the estate as it is now and
 * a backup knows the one it was taken in. Afterwards the box is a controller
 * in a new dataset, and its members take a snapshot and hold exactly its
 * data of record.
 *
 * The controller is the process's own database at DATA_DIR, since that is
 * what a restore replaces; it answers the sync routes over HTTPS on its sync
 * identity. Each member is a database of its own, handed to the member code.
 * `boot` is the part of src/index.js that follows a restore's restart.
 *
 * Also here: who may take a backup or restore one at all.
 */
// First: the modules below read DATA_DIR when they load.
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import request from 'supertest';
import { cleanupTestDb } from '../helpers/test-db.js';
import { databaseThrough, LATEST_MIGRATION } from '../helpers/migrations.js';
import { makeController, makeMember } from '../helpers/member-mode.js';
import { getDb, initDb } from '../../src/db/init.js';
import syncRoutes from '../../src/routes/sync.js';
import { ensureSyncIdentity } from '../../src/sync/identity.js';
import {
  CONTROLLER,
  ensureSyncLog,
  estateTables,
  GUARD_MESSAGE,
  readSyncState,
  storedMode,
  syncHead,
  syncStatus,
  writeSyncState,
} from '../../src/sync/log.js';
import { backupRefusal, isFenced } from '../../src/sync/mode.js';
import { setEpochBase, setFenced, setHandoverFreeze } from '../../src/sync/promotion-state.js';
import { detachRestoredDatabase, keepPresentInstances } from '../../src/sync/restore.js';
import { memberWriteGate } from '../../src/sync/write-gate.js';
import { joinController, syncOnce } from '../../src/sync/member.js';
import {
  createJoinToken,
  ensureOwnInstance,
  exportInstances,
  ownInstanceId,
} from '../../src/models/sync-instance.js';
import { readSetting, upsertSetting } from '../../src/models/setting.js';
import {
  applyRestoreCarryover,
  createBackup,
  getBackupPath,
  restoreBackup,
  startBackupScheduler,
} from '../../src/utils/backup.js';

const dataDir = DATA_DIR;
const tmpDirs = [];
let identity;
let server;
let port;

/** What src/index.js does after a restore's restart, as far as instances go. */
async function boot() {
  await initDb(dataDir);
  const db = getDb();
  applyRestoreCarryover(db);
  if (storedMode(db) === CONTROLLER) {
    ensureOwnInstance(db, {
      fingerprint: identity.fingerprint,
      port,
      version: 'test',
      dnsAddresses: [],
    });
  }
  return db;
}

beforeAll(async () => {
  // The restore schedules the process exit that lets systemd restart it.
  vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  identity = ensureSyncIdentity(dataDir);
  // The routes ask for the database at each request, so the server can
  // listen first: the port it is given is the one the controller's row names.
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ({ port } = server.address());
  const db = await boot();
  db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('restore-admin', 'x', 'admin', 0)",
  ).run();
});
afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  vi.restoreAllMocks();
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  cleanupTestDb(dataDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A new install at the current schema, with its own sync identity. */
function newBox() {
  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  ensureSyncIdentity(tmpDir);
  return { db, dir: tmpDir, id: ownInstanceId(db) };
}

async function join(box) {
  const { token } = createJoinToken(getDb(), { fingerprint: identity.fingerprint });
  await joinController(box.db, { address: '127.0.0.1', port, token }, { restart: () => {} });
  await syncOnce(box.db);
  return box;
}

// restoreBackup schedules the exit; wait it out against the stubbed one.
async function restoreAndBoot(filename) {
  process.exit.mockClear();
  await restoreBackup(getBackupPath(filename), { restoredBy: { username: 'restore-admin' } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(process.exit).toHaveBeenCalledWith(0);
  return boot();
}

/** The data of record of `db`, table by table, in key order. */
function dataOfRecord(db) {
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

// The list as the estate knows it: who, where, and the credential each presents.
const listOf = (db) =>
  exportInstances(db).map(
    ({
      id,
      instance_id,
      name,
      address,
      port: at,
      fingerprint,
      credential_hash,
      is_controller,
    }) => ({
      id,
      instance_id,
      name,
      address,
      port: at,
      fingerprint,
      credential_hash,
      is_controller,
    }),
  );
const stateOf = (db) =>
  Object.fromEntries(
    db
      .prepare('SELECT key, value FROM sync_state')
      .all()
      .map((row) => [row.key, row.value]),
  );
const folders = (db) =>
  db
    .prepare('SELECT name FROM folders ORDER BY name')
    .all()
    .map((row) => row.name);
const addFolder = (db, name) => db.prepare('INSERT INTO folders (name) VALUES (?)').run(name);
const BACKUP_STANDING = [
  'mode',
  'controller',
  'cursor',
  'copy_from',
  'fenced',
  'handover',
  'epoch_base',
];
const restoreRow = (db) =>
  JSON.parse(
    db
      .prepare(
        "SELECT details FROM audit_log WHERE action = 'backup_restored' ORDER BY id DESC LIMIT 1",
      )
      .get().details,
  );

/** Another controller's database, with members of its own, at epoch 5. */
function otherEstate({ through = LATEST_MIGRATION } = {}) {
  const { db } = databaseThrough(through, { tmpDirs });
  addFolder(db, 'Theirs');
  db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('restore-admin', 'x', 'admin', 0)",
  ).run();
  return db;
}

describe('a single box restoring a backup of another controller', () => {
  let own;
  let archive;
  let db;

  beforeAll(async () => {
    const other = otherEstate();
    const otherId = ownInstanceId(other);
    writeSyncState(other, 'epoch', 5);
    writeSyncState(other, 'epoch_base', 12);
    writeSyncState(other, 'dataset', 'their-dataset');
    const row = other.prepare(
      `INSERT INTO sync_instances (instance_id, name, address, fingerprint, credential_hash, is_controller)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    row.run(otherId, 'their-controller', '192.0.2.1', 'aa'.repeat(32), null, 1);
    row.run('their-member', 'their-member', '192.0.2.2', 'bb'.repeat(32), 'cc'.repeat(32), 0);
    upsertSetting(other, 'dhcp_active_instance', 'their-member');
    upsertSetting(other, 'dhcp_term', '7');
    upsertSetting(other, 'controller_handover_to', 'their-member');
    upsertSetting(other, 'controller_handover_since', '2026-01-01T00:00:00Z');
    archive = await createBackup(other);
    other.close();

    own = { id: ownInstanceId(getDb()), list: listOf(getDb()) };
    addFolder(getDb(), 'Mine, before the restore');
    db = await restoreAndBoot(archive.filename);
  });

  it('takes the data of the backup', () => {
    expect(folders(db)).toEqual(['Theirs']);
  });

  it('ends as a single box: itself in the list, under its own id, at its own epoch', () => {
    expect(own.list).toHaveLength(1);
    expect(listOf(db)).toEqual(own.list);
    expect(ownInstanceId(db)).toBe(own.id);
    expect(storedMode(db)).toBe(CONTROLLER);
    expect(syncStatus(db).epoch).toBe(1);
    for (const key of BACKUP_STANDING) expect(readSyncState(db, key), key).toBeNull();
    expect(syncStatus(db).dataset).not.toBe('their-dataset');
  });

  it('serves DHCP itself, and is in no handover', () => {
    for (const key of [
      'dhcp_active_instance',
      'dhcp_term',
      'controller_handover_to',
      'controller_handover_since',
    ]) {
      expect(readSetting(db, key), key).toBeNull();
    }
    expect(backupRefusal(db)).toBeNull();
  });

  it('applies what it kept once, and says so in the audit row of the restore', () => {
    expect(readSetting(db, 'restore_carryover')).toBeNull();
    expect(restoreRow(db)).toMatchObject({ epoch_kept: 1, members_kept: 0 });
  });
});

describe('a controller with two members at epoch 3, DHCP on a member', () => {
  let a;
  let b;
  let early;
  let present;

  beforeAll(async () => {
    const db = getDb();
    addFolder(db, 'Before the backup');
    a = await join(newBox());
    // Taken at epoch 1, with one member, DHCP on the controller.
    early = await createBackup(db);

    b = await join(newBox());
    addFolder(db, 'After the backup');
    // Two changes of controller later this box is the controller again.
    writeSyncState(db, 'epoch', 3);
    setEpochBase(db, syncHead(db));
    upsertSetting(db, 'dhcp_active_instance', a.id);
    upsertSetting(db, 'dhcp_term', '2');
    upsertSetting(db, 'dhcp_handover_from', ownInstanceId(db));
    upsertSetting(db, 'dhcp_handover_since', '2026-11-01T00:00:00.000Z');
    writeSyncState(db, 'dhcp_ready_term', 1);
    for (const member of [a, b]) await syncOnce(member.db);
    expect(syncStatus(a.db).epoch).toBe(3);
    expect(dataOfRecord(b.db)).toEqual(dataOfRecord(db));
    present = { list: listOf(db), dataset: syncStatus(db).dataset, id: ownInstanceId(db) };
    expect(present.list.map((row) => row.name)).toHaveLength(3);
  });

  describe('restoring its own backup from epoch 1', () => {
    let db;
    beforeAll(async () => {
      db = await restoreAndBoot(early.filename);
    });

    it('takes the data of the backup', () => {
      expect(folders(db)).toEqual(['Before the backup', 'Theirs']);
    });

    it('is the controller at the epoch it had, in a new dataset', () => {
      expect(storedMode(db)).toBe(CONTROLLER);
      expect(syncStatus(db).epoch).toBe(3);
      expect(syncStatus(db).dataset).not.toBe(present.dataset);
      for (const key of BACKUP_STANDING) expect(readSyncState(db, key), key).toBeNull();
      expect(readSyncState(db, 'dhcp_ready_term')).toBe('1');
      expect(ownInstanceId(db)).toBe(present.id);
    });

    it('keeps the instances it had: both members, their ids and their credentials', () => {
      expect(listOf(db)).toEqual(present.list);
      expect(restoreRow(db)).toMatchObject({ epoch_kept: 3, members_kept: 2 });
    });

    it('leaves DHCP with the member that served it, at the same term', () => {
      expect(readSetting(db, 'dhcp_active_instance')).toBe(a.id);
      expect(readSetting(db, 'dhcp_term')).toBe('2');
      expect(readSetting(db, 'dhcp_handover_from')).toBe(present.id);
      expect(readSetting(db, 'dhcp_handover_since')).toBe('2026-11-01T00:00:00.000Z');
      expect(readSetting(db, 'controller_handover_to')).toBeNull();
    });

    it('is followed by both members, which hold exactly its data of record', async () => {
      for (const member of [a, b]) {
        await syncOnce(member.db);
        expect(syncStatus(member.db).dataset).toBe(syncStatus(db).dataset);
        expect(dataOfRecord(member.db)).toEqual(dataOfRecord(db));
        expect(folders(member.db)).toEqual(['Before the backup', 'Theirs']);
      }
      // Nobody named a higher epoch: the controller is still the controller.
      expect(isFenced(db)).toBe(false);
      expect(storedMode(db)).toBe(CONTROLLER);
      expect(syncStatus(db).epoch).toBe(3);
      addFolder(db, 'After the restore');
      await syncOnce(b.db);
      expect(folders(b.db)).toContain('After the restore');
    });
  });

  describe('restoring a backup from before instances (0.6.x, schema 94)', () => {
    let db;
    let before;
    beforeAll(async () => {
      const legacy = otherEstate({ through: 94 });
      expect(
        legacy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_state'").get(),
      ).toBeUndefined();
      const archive = await createBackup(legacy);
      legacy.close();
      expect(archive.schema_version).toBe(94);
      before = { list: listOf(getDb()), dataset: syncStatus(getDb()).dataset };
      db = await restoreAndBoot(archive.filename);
    });

    it('migrates it, and ends the same way: its instances, epoch and DHCP assignment', () => {
      expect(syncStatus(db).schema).toBe(LATEST_MIGRATION);
      expect(folders(db)).toEqual(['Theirs']);
      expect(storedMode(db)).toBe(CONTROLLER);
      expect(syncStatus(db).epoch).toBe(3);
      expect(syncStatus(db).dataset).not.toBe(before.dataset);
      expect(listOf(db)).toEqual(before.list);
      expect(readSetting(db, 'dhcp_active_instance')).toBe(a.id);
      expect(readSetting(db, 'dhcp_term')).toBe('2');
      expect(readSyncState(db, 'dhcp_ready_term')).toBe('1');
      expect(readSetting(db, 'restore_carryover')).toBeNull();
    });

    it('is followed by both members, which hold exactly its data of record', async () => {
      for (const member of [a, b]) {
        await syncOnce(member.db);
        expect(dataOfRecord(member.db)).toEqual(dataOfRecord(db));
        expect(folders(member.db)).toEqual(['Theirs']);
      }
      expect(isFenced(db)).toBe(false);
      expect(syncStatus(db).epoch).toBe(3);
    });
  });
});

describe('the database a restore stages', () => {
  it('is made a controller’s, whatever the box it was taken on was', () => {
    const { db } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
    addFolder(db, 'Kept');
    makeMember(db);
    writeSyncState(db, 'cursor', 40);
    writeSyncState(db, 'dataset', 'old');
    writeSyncState(db, 'epoch', 2);
    setEpochBase(db, 9);
    setFenced(db, { epoch: 3, by_name: 'beta', since: 'then' });
    setHandoverFreeze(db, { to_name: 'beta', since: 'then' });
    ensureSyncLog(db, tmpDirs.at(-1));
    expect(() => addFolder(db, 'Refused')).toThrow(GUARD_MESSAGE);

    detachRestoredDatabase(db);
    expect(storedMode(db)).toBe(CONTROLLER);
    expect(Object.keys(stateOf(db))).not.toEqual(expect.arrayContaining(BACKUP_STANDING));
    expect(readSyncState(db, 'dataset')).toBeNull();
    // A member's guards would refuse what the restore writes next.
    expect(() => addFolder(db, 'Written')).not.toThrow();
    expect(folders(db)).toEqual(['Kept', 'Written']);
  });

  it('drops a handover the backup was taken in, and an assignment the box did not have', () => {
    const { db } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
    upsertSetting(db, 'controller_handover_to', 'x');
    upsertSetting(db, 'controller_handover_since', 'then');
    upsertSetting(db, 'dhcp_active_instance', 'x');
    upsertSetting(db, 'dhcp_term', '4');
    const kept = db.transaction(() =>
      keepPresentInstances(db, {
        state: { instance_id: 'me', epoch: 6, instance_name: null, dhcp_ready_term: null },
        settings: { dhcp_term: '9' },
        rows: [],
      }),
    )();
    expect(kept).toEqual({ epoch: 6, members: 0 });
    expect(readSyncState(db, 'instance_id')).toBe('me');
    expect(readSetting(db, 'dhcp_term')).toBe('9');
    for (const key of [
      'controller_handover_to',
      'controller_handover_since',
      'dhcp_active_instance',
    ]) {
      expect(readSetting(db, key), key).toBeNull();
    }
  });
});

describe('who takes a backup or restores one', () => {
  const gate = express();
  gate.use(memberWriteGate);
  gate.use((req, res) => res.json({ ok: true }));
  const backupCount = () => getDb().prepare('SELECT count(*) AS n FROM backups').get().n;
  let archive;

  beforeAll(async () => {
    archive = await createBackup(getDb());
  });

  const cases = [
    {
      name: 'a member',
      enter: (db) => makeMember(db, { name: 'ctl-1' }),
      leave: makeController,
      code: 'member_read_only',
      error:
        'This is a member of ctl-1: it holds a copy of the data, not the record. ' +
        'Take backups and restore them on ctl-1.',
    },
    {
      name: 'a controller that was replaced',
      enter: (db) => {
        makeMember(db);
        db.prepare("DELETE FROM sync_state WHERE key = 'controller'").run();
        setFenced(db, { epoch: 4, by_instance_id: 'b', by_name: 'beta', since: 'then' });
      },
      leave: (db) => {
        setFenced(db, null);
        makeController(db);
      },
      code: 'controller_fenced',
      error:
        'beta took over as the controller, so this CIDRella no longer holds the record. ' +
        'Take backups and restore them on beta.',
    },
    {
      name: 'a controller handing over',
      enter: (db) => setHandoverFreeze(db, { to_instance_id: 'b', to_name: 'beta', since: 'then' }),
      leave: (db) => setHandoverFreeze(db, null),
      code: 'controller_handover',
      error:
        'The controller is being handed over to beta. Cancel the handover first, ' +
        'or take backups and restore them on beta once it has taken over.',
    },
  ];

  for (const { name, enter, leave, code, error } of cases) {
    it(`${name} refuses both, and says where to go`, async () => {
      const db = getDb();
      const count = backupCount();
      const dataset = syncStatus(db).dataset;
      enter(db);
      try {
        expect(backupRefusal(db)).toEqual({ error, code });
        await expect(createBackup(db)).rejects.toMatchObject({
          code: 'BACKUP_NOT_HERE',
          reason: code,
          message: error,
        });
        await expect(restoreBackup(getBackupPath(archive.filename))).rejects.toMatchObject({
          code: 'BACKUP_NOT_HERE',
          reason: code,
          message: error,
        });
        for (const path of ['/api/operations/backup', '/api/operations/restore']) {
          const answer = await request(gate).post(path);
          expect(answer.status).toBe(409);
          expect(answer.body).toEqual({ error, code });
        }
        // Any other write keeps the sentence it had.
        const other = await request(gate).post('/api/folders');
        expect(other.status).toBe(409);
        expect(other.body.code).toBe(code);
        expect(other.body.error).not.toBe(error);
      } finally {
        leave(db);
      }
      expect(backupCount()).toBe(count);
      // Nothing was staged, swapped or forgotten.
      expect(getDb()).toBe(db);
      expect(syncStatus(db).dataset).toBe(dataset);
      expect(process.exit).not.toHaveBeenCalledWith(1);
    });
  }

  it('the scheduler takes none while the controller hands over, and one once it is called off', async () => {
    const db = getDb();
    upsertSetting(db, 'backup_schedule', 'daily');
    db.prepare("DELETE FROM settings WHERE key = 'backup_last_run'").run();
    const scheduled = () =>
      db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'backup_created'").get().n;
    const failed = () =>
      db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'backup_failed'").get().n;
    const before = { count: backupCount(), scheduled: scheduled(), failed: failed() };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const timer = startBackupScheduler();
    try {
      setHandoverFreeze(db, { to_instance_id: 'b', to_name: 'beta', since: 'then' });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(backupCount()).toBe(before.count);
      expect(failed()).toBe(before.failed);
      expect(readSetting(db, 'backup_last_run')).toBeNull();

      setHandoverFreeze(db, null);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await vi.waitFor(() => expect(readSetting(db, 'backup_last_run')).not.toBeNull(), {
        timeout: 20_000,
      });
      expect(backupCount()).toBe(before.count + 1);
      expect(scheduled()).toBe(before.scheduled + 1);
    } finally {
      clearInterval(timer);
      vi.useRealTimers();
      upsertSetting(db, 'backup_schedule', 'off');
    }
  });

  it('a database from before instances is a controller’s', () => {
    const { db } = databaseThrough(94, { tmpDirs });
    expect(backupRefusal(db)).toBeNull();
  });
});
