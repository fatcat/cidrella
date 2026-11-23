/**
 * What keeps a restore from losing a member: a join while the restore runs is
 * refused (RESTORE-JOIN-RACE-01), and a boot whose carry-over failed answers
 * no other instance and says so on the Instances page
 * (RESTORE-CARRYOVER-FAIL-01). The controller is the test database; the box
 * that joins is a database of its own, handed to the member code over a
 * real HTTPS connection pinned to the controller's sync identity.
 */
// First: utils/backup.js reads DATA_DIR when it loads.
import '../helpers/isolated-data-dir.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import request from 'supertest';

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { listenLocal } = await import('../helpers/free-port.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { default: instanceRoutes } = await import('../../src/routes/instances.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { MEMBER, storedMode, syncStatus, writeSyncState } = await import('../../src/sync/log.js');
const { joinController, JoinError } = await import('../../src/sync/member.js');
const { createJoinToken, ensureOwnInstance, listInstances } =
  await import('../../src/models/sync-instance.js');
const { readSetting, upsertSetting } = await import('../../src/models/setting.js');
const {
  CARRYOVER_FAILED_CODE,
  presentInstances,
  refuseAfterFailedCarryover,
  restoreUnderWay,
  setCarryoverFailed,
  setRestoreUnderWay,
} = await import('../../src/sync/restore.js');
const { applyRestoreCarryover, RESTORE_CARRYOVER_KEY, restoreBackup } =
  await import('../../src/utils/backup.js');

let controller;
let controllerDir;
let identity;
let app;
let server;
let port;
const tmpDirs = [];

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  identity = ensureSyncIdentity(controllerDir);
  ensureOwnInstance(controller, {
    fingerprint: identity.fingerprint,
    port: 8443,
    version: 'test',
    dnsAddresses: [],
  });
  // As src/index.js mounts them.
  app = express();
  app.use(express.json());
  app.use('/api/sync', refuseAfterFailedCarryover);
  app.use('/api/sync', syncRoutes);
  app.use((req, res, next) => {
    req.user = { id: 1, role: 'admin', username: 'testadmin' };
    next();
  });
  app.use('/api/instances', instanceRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  port = await listenLocal(server);
});
afterEach(() => {
  setRestoreUnderWay(null);
  setCarryoverFailed(false);
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupTestDb(controllerDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A new install at the same schema, with its own sync identity. */
function newBox() {
  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  ensureSyncIdentity(tmpDir);
  return { db, dir: tmpDir };
}

const token = () => createJoinToken(controller, { fingerprint: identity.fingerprint }).token;
const join = (box, joinToken) =>
  joinController(box.db, { address: '127.0.0.1', port, token: joinToken }, { restart: () => {} });
const members = () => listInstances(controller).filter((row) => !row.is_controller);

describe('a join while a restore runs', () => {
  it('is refused in words the join screen shows, and the token stays good', async () => {
    const box = newBox();
    const joinToken = token();
    setRestoreUnderWay(controller);
    const err = await join(box, joinToken).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.code).toBe('restoring');
    expect(err.message).toBe(
      'This CIDRella is restoring a backup. Wait for it to restart, make a new join token there, then join.',
    );
    expect(storedMode(box.db)).not.toBe(MEMBER);
    expect(members()).toEqual([]);

    // A restore that failed before the swap lets the same token in.
    setRestoreUnderWay(null);
    await expect(join(box, joinToken)).resolves.toMatchObject({ controller: {} });
    expect(members()).toHaveLength(1);
  });

  it('is still refused a token it does not have', async () => {
    setRestoreUnderWay(controller);
    const res = await request(app)
      .post('/api/sync/join')

      .send({
        token: 'nonsense',
        instance_id: '00000000-0000-4000-8000-000000000001',
        name: 'ns9',
        port: 8443,
        fingerprint: 'ab'.repeat(32),
        version: 'test',
        schema: syncStatus(controller).schema,
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('token_refused');
  });
});

describe('restoreBackup', () => {
  it('holds joins off while it runs, and lets them in again when it fails before the swap', async () => {
    let during = null;
    const inspection = {
      get compatible() {
        during = restoreUnderWay(controller);
        return false;
      },
      reason: 'not this one',
    };
    await expect(restoreBackup('/nonexistent.tar.gz', { inspection })).rejects.toMatchObject({
      code: 'BACKUP_INCOMPATIBLE',
    });
    expect(during).toBe(true);
    expect(restoreUnderWay(controller)).toBe(false);
  });
});

describe('a boot whose restore carry-over failed', () => {
  it('answers no other instance on any sync route', async () => {
    setCarryoverFailed(true);
    for (const path of ['/api/sync/hello', '/api/sync/changes', '/api/sync/collected/metrics']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe(CARRYOVER_FAILED_CODE);
    }
    const joined = await join(newBox(), token()).catch((e) => e);
    expect(joined.code).toBe(CARRYOVER_FAILED_CODE);
  });

  it('says so on the instances list, and not on a boot that finished it', async () => {
    const list = () =>
      request(app)
        .get('/api/instances')

        .then((res) => res.body.restore_unfinished);
    expect(await list()).toBe(false);
    setCarryoverFailed(true);
    expect(await list()).toBe(true);
  });

  it('keeps the parked carry-over, so the next boot tries again', () => {
    const epoch = syncStatus(controller).epoch;
    const kept = presentInstances(controller);
    const parked = { instances: { ...kept, state: { ...kept.state, epoch: epoch + 5 } } };
    upsertSetting(controller, RESTORE_CARRYOVER_KEY, JSON.stringify(parked));
    controller.exec(
      `CREATE TEMP TRIGGER carryover_fails BEFORE DELETE ON settings
       WHEN OLD.key = '${RESTORE_CARRYOVER_KEY}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    try {
      expect(() => applyRestoreCarryover(controller)).toThrow('disk full');
      expect(readSetting(controller, RESTORE_CARRYOVER_KEY)).not.toBeNull();
      expect(syncStatus(controller).epoch).toBe(epoch);
    } finally {
      controller.exec('DROP TRIGGER carryover_fails');
    }
    expect(applyRestoreCarryover(controller)).toMatchObject({ instances: { epoch: epoch + 5 } });
    expect(readSetting(controller, RESTORE_CARRYOVER_KEY)).toBeNull();
    writeSyncState(controller, 'epoch', epoch);
  });
});
