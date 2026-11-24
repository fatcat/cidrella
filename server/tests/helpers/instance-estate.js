/**
 * An estate of instances for a test: a controller and its members, each a
 * database of its own with its own HTTPS server on its sync identity and its
 * own routes, all in one process (tests/helpers/instances.js).
 *
 * The test file mocks db/init.js with `perInstanceDb` and backends/index.js
 * with `fakeBackendsModule` BEFORE it imports this module, then calls
 * `useEstates()` once. A restart is a function that does nothing, so each
 * box carries on in the mode its database says; `reboot` runs what boot does
 * to the log.
 *
 * One file can join about 20 boxes: the join route is rate limited per
 * address (routes/sync.js) and every box here is 127.0.0.1.
 */
import { afterAll, beforeAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import request from 'supertest';
import { backend } from '../../src/backends/index.js';
import { getDb } from '../../src/db/init.js';
import { closeAnalyticsDb, initAnalyticsDb } from '../../src/db/duckdb.js';
import {
  createJoinToken,
  ensureOwnInstance,
  ownInstanceId,
} from '../../src/models/sync-instance.js';
import { upsertSetting } from '../../src/models/setting.js';
import featuresRoutes from '../../src/routes/features.js';
import instanceRoutes from '../../src/routes/instances.js';
import collectedRoutes from '../../src/routes/sync-collected.js';
import syncRoutes from '../../src/routes/sync.js';
import { setPromotionRestart } from '../../src/services/controller-promotion.js';
import { parseChanges } from '../../src/sync/changes.js';
import { readCredential } from '../../src/sync/credential.js';
import { ensureSyncIdentity } from '../../src/sync/identity.js';
import {
  CONTROLLER,
  ensureSyncLog,
  estateTables,
  readSyncState,
  storedMode,
  syncStatus,
  writeSyncState,
} from '../../src/sync/log.js';
import { joinController, syncOnce } from '../../src/sync/member.js';
import { memberWriteGate } from '../../src/sync/write-gate.js';
import { afterCommitMiddleware } from '../../src/utils/after-commit.js';
import { actorMiddleware } from '../../src/utils/request-actor.js';
import { syncRequest } from '../../src/utils/sync-client.js';
import { listenLocal } from './free-port.js';
import { inInstance } from './instances.js';
import { databaseThrough, LATEST_MIGRATION } from './migrations.js';
import { cleanupTestDb, setupTestDb } from './test-db.js';

const tmpDirs = [];
const servers = [];
let processDir;
let undoRestart;

/**
 * Call once at the top of a test file: the process's own database, the
 * analytics store, a restart that does nothing, and the cleanup of every box.
 */
export function useEstates() {
  beforeAll(async () => {
    // The process's own database: the hook handlers, and the analytics store
    // every instance here shares.
    ({ tmpDir: processDir } = await setupTestDb());
    await initAnalyticsDb(processDir);
    undoRestart = setPromotionRestart(() => {});
    backend.dhcp.importLeases = vi.fn(async (leases) => ({ added: leases.length, failed: [] }));
    backend.activate = vi.fn(async ({ force = false } = {}) => (force ? 'restarted' : 'unchanged'));
    backend.seedLeases([]);
  });
  afterAll(async () => {
    undoRestart();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            // A member's long poll may still be open.
            server.closeAllConnections();
          }),
      ),
    );
    await closeAnalyticsDb();
    cleanupTestDb(processDir);
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** A new install with its sync identity, its routes and its HTTPS server. */
export async function box(name) {
  const { db, tmpDir: dir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  const identity = ensureSyncIdentity(dir);
  writeSyncState(db, 'instance_name', name);
  ensureSyncLog(db, dir);

  const app = express();
  app.use(express.json());
  app.use(inInstance(db));
  app.use('/api/sync/collected', collectedRoutes);
  app.use('/api/sync', syncRoutes);
  app.use((req, res, next) => {
    req.user = { id: 1, role: 'admin', username: 'testadmin' };
    next();
  });
  app.use(actorMiddleware);
  app.use(afterCommitMiddleware);
  app.use(memberWriteGate);
  app.use('/api/instances', instanceRoutes);
  app.use('/api/features', featuresRoutes);
  // A write to the data of record, standing for every route that makes one.
  app.put('/api/settings/:key', (req, res) => {
    upsertSetting(getDb(), req.params.key, req.body.value);
    res.json({ ok: true });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  const self = { name, db, dir, identity, app, port: null, id: ownInstanceId(db) };
  // The box is off while `unplugged`: every connection is dropped as it
  // arrives, so callers see it unreachable. The port stays bound: closed and
  // bound again, it could be taken in between by another test file running
  // beside this one, and the box could not come back at its address.
  self.unplugged = false;
  self.listen = async () => {
    self.unplugged = false;
    if (self.server) return;
    self.server = https.createServer(
      { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
      app,
    );
    self.server.on('connection', (socket) => {
      if (self.unplugged) socket.destroy();
    });
    servers.push(self.server);
    self.port = await listenLocal(self.server);
  };
  self.unplug = async () => {
    self.unplugged = true;
    self.server.closeAllConnections();
  };
  await self.listen();
  return self;
}

export function asController(one) {
  // The admin the requests below are made as.
  if (!one.db.prepare('SELECT 1 FROM users WHERE id = 1').get()) {
    one.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'testadmin', 'x', 'admin')",
      )
      .run();
  }
  ensureOwnInstance(one.db, {
    fingerprint: one.identity.fingerprint,
    port: one.port,
    version: 'test',
    dnsAddresses: [],
  });
}

/** What boot does to the change log, and to the controller's own row. */
export function reboot(one) {
  const result = ensureSyncLog(one.db, one.dir);
  if (storedMode(one.db) === CONTROLLER) asController(one);
  return result;
}

export async function join(member, controller) {
  const { token } = createJoinToken(controller.db, {
    fingerprint: controller.identity.fingerprint,
  });
  await joinController(
    member.db,
    { address: '127.0.0.1', port: controller.port, token },
    { restart: () => {} },
  );
  // The join reports the port the web server listens on, which here is not
  // the test server's.
  controller.db
    .prepare('UPDATE sync_instances SET port = ? WHERE instance_id = ?')
    .run(member.port, member.id);
}

/** A controller and its members, every member current. */
export async function estate(...names) {
  const boxes = [];
  for (const name of names) boxes.push(await box(name));
  const [controller, ...members] = boxes;
  asController(controller);
  for (const member of members) await join(member, controller);
  for (const member of members) await syncOnce(member.db);
  return boxes;
}

export const api = (one) => request(one.app);
export const write = (one, value) => api(one).put('/api/settings/map_home').send({ value });
export const rowOf = (on, other) =>
  on.db.prepare('SELECT * FROM sync_instances WHERE instance_id = ?').get(other.id);
export const epochOf = (one) => syncStatus(one.db).epoch;

/** The data of record of `db`, table by table, in key order. */
export function dataOfRecord(db) {
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

/** What `to` would send `from` now, read without applying it. */
export async function changesFor(from, to) {
  const local = syncStatus(from.db);
  const query = new URLSearchParams({
    schema: local.schema,
    epoch: local.epoch,
    dataset: local.dataset,
    since: readSyncState(from.db, 'cursor'),
  });
  const copyFrom = readSyncState(from.db, 'copy_from');
  if (copyFrom) query.set('from', copyFrom);
  const response = await syncRequest({
    address: '127.0.0.1',
    port: to.port,
    fingerprint: to.identity.fingerprint,
    path: `/api/sync/changes?${query}`,
    credential: readCredential(from.db),
  });
  return response.status === 200 ? parseChanges(response.body) : { status: response.status };
}

export const hello = (to, credential, headers = {}) =>
  syncRequest({
    address: '127.0.0.1',
    port: to.port,
    fingerprint: to.identity.fingerprint,
    path: '/api/sync/hello',
    credential,
    headers,
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body.toString('utf8')),
  }));
