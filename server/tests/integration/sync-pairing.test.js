/**
 * A member joining a controller and following it, over a real HTTPS
 * connection pinned to the controller's sync identity: two databases, one
 * process. The controller is the test database (the routes read it); the
 * member is a database of its own, handed to the member code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { freePort } = await import('../helpers/free-port.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { estateTables, GUARD_MESSAGE, MEMBER, storedMode, syncStatus } =
  await import('../../src/sync/log.js');
const { controllerOf } = await import('../../src/sync/mode.js');
const { joinController, JoinError, sendOutbox, syncOnce } =
  await import('../../src/sync/member.js');
const { createJoinToken, listInstances, removeMember } =
  await import('../../src/models/sync-instance.js');
const { replaceLeases } = await import('../../src/models/dhcp-lease.js');
const { setSetting } = await import('../../src/db/init.js');
const { recordAudit } = await import('../../src/services/audit.js');

let controller;
let controllerDir;
let identity;
let server;
let port;
const tmpDirs = [];

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  enableIpv6(controller);
  identity = ensureSyncIdentity(controllerDir);
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
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
const join = (box, joinToken = token()) =>
  joinController(box.db, { address: '127.0.0.1', port, token: joinToken }, { restart: () => {} });

/** The data of record of `db`, table by table, in key order. */
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

describe('joining a controller', () => {
  it('refuses a token that is not one, and one the controller never made', async () => {
    const box = newBox();
    await expect(join(box, 'nonsense')).rejects.toMatchObject({ code: 'token_refused' });
    const forged = `cj1_${identity.fingerprint}_${'x'.repeat(43)}`;
    await expect(join(box, forged)).rejects.toMatchObject({ code: 'token_refused' });
    expect(storedMode(box.db)).not.toBe(MEMBER);
    expect(listInstances(controller).filter((row) => !row.is_controller)).toEqual([]);
  });

  it('refuses a controller whose certificate is not the one the token names', async () => {
    const box = newBox();
    const other = `cj1_${'ab'.repeat(32)}_${'x'.repeat(43)}`;
    const err = await join(box, other).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.code).toBe('pin_mismatch');
    expect(storedMode(box.db)).not.toBe(MEMBER);
  });

  it('refuses a box on another schema, and keeps the token for a retry', async () => {
    const box = newBox();
    box.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_MIGRATION + 1);
    const joinToken = token();
    await expect(join(box, joinToken)).rejects.toMatchObject({ code: 'schema_mismatch' });
    box.db.prepare('DELETE FROM schema_version WHERE version = ?').run(LATEST_MIGRATION + 1);
    await expect(join(box, joinToken)).resolves.toMatchObject({ controller: {} });
  });
});

describe('a join that fails after the controller said yes', () => {
  it('leaves the box as it was and off the controller’s list', async () => {
    const box = newBox();
    // The first copy cannot be applied: its last step, the cursor, is refused.
    box.db.exec(
      "CREATE TRIGGER break_apply BEFORE INSERT ON sync_state WHEN NEW.key = 'cursor' BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    const before = listInstances(controller).length;
    const settings = () => box.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const had = settings();

    const err = await join(box).catch((e) => e);

    expect(settings()).toEqual(had);

    expect(err).toBeInstanceOf(JoinError);
    expect(storedMode(box.db)).not.toBe(MEMBER);
    expect(fs.existsSync(path.join(box.dir, 'sync', 'credential'))).toBe(false);
    expect(listInstances(controller)).toHaveLength(before);
  });
});

describe('a member', () => {
  let box;
  beforeAll(async () => {
    box = newBox();
    setSetting('map_home', '1,2');
    await join(box);
  });

  it('holds the controller’s data of record and knows its controller', () => {
    expect(storedMode(box.db)).toBe(MEMBER);
    expect(estate(box.db)).toEqual(estate(controller));
    expect(controllerOf(box.db)).toMatchObject({
      address: '127.0.0.1',
      port,
      fingerprint: identity.fingerprint,
    });
    const credential = path.join(box.dir, 'sync', 'credential');
    expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
    expect(
      box.db.prepare("SELECT value FROM settings WHERE key = 'dhcp_enabled'").get().value,
    ).toBe('false');
  });

  it('is on the controller’s list, by the address it called from', () => {
    const row = listInstances(controller).find((r) => !r.is_controller && r.last_contact_at);
    expect(row).toMatchObject({
      address: '127.0.0.1',
      schema_version: syncStatus(controller).schema,
    });
  });

  it('cannot reuse its join token', async () => {
    const joinToken = token();
    await join(newBox(), joinToken);
    await expect(join(newBox(), joinToken)).rejects.toMatchObject({ code: 'token_refused' });
  });

  it('refuses a write to the data of record, and takes one about itself', () => {
    expect(() =>
      box.db.prepare("UPDATE settings SET value = '9,9' WHERE key = 'map_home'").run(),
    ).toThrow(GUARD_MESSAGE);
    expect(() =>
      box.db.prepare("INSERT INTO settings (key, value) VALUES ('map_home_2', 'x')").run(),
    ).not.toThrow();
    box.db.prepare("DELETE FROM settings WHERE key = 'map_home_2'").run();
    expect(() => box.db.prepare('DELETE FROM users').run()).toThrow(GUARD_MESSAGE);
    expect(() => box.db.prepare("INSERT INTO folders (name) VALUES ('nope')").run()).toThrow(
      GUARD_MESSAGE,
    );
    // Host keys and host columns stay its own.
    box.db.prepare("UPDATE settings SET value = '8443' WHERE key = 'https_port'").run();
    box.db.prepare("UPDATE sync_instances SET last_contact_at = 'now'").run();
  });

  it('follows the controller, both address families', async () => {
    const subnet = controller
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
           total_addresses, status) VALUES ('10.88.0.0/24', 'pair', '10.88.0.0', '10.88.0.255', 24, 256, 'allocated')`,
      )
      .run().lastInsertRowid;
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    replaceLeases(
      controller,
      [
        {
          ip: '10.88.0.10',
          mac: 'aa:bb:cc:88:00:10',
          hostname: 'four',
          expiresAt: inAnHour,
          subnetId: subnet,
        },
        {
          ip: '2001:db8:88::10',
          hostname: 'six',
          expiresAt: inAnHour,
          subnetId: null,
          duid: '00:01:00:01:aa',
        },
      ],
      { lifecycleValidated: true },
    );
    setSetting('map_home', '3,4');
    await expect(syncOnce(box.db)).resolves.toBe('current');
    expect(estate(box.db)).toEqual(estate(controller));
    expect(box.db.prepare('SELECT ip_address FROM dhcp_leases ORDER BY id').all()).toHaveLength(2);

    controller.prepare('DELETE FROM dhcp_leases').run();
    await syncOnce(box.db);
    expect(estate(box.db)).toEqual(estate(controller));
  });

  it('waits on the controller when there is nothing new, and tells it where it is', async () => {
    const started = Date.now();
    await expect(syncOnce(box.db, { wait: 1 })).resolves.toBe('current');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const mine = controllerOf(box.db);
    expect(mine).not.toBeNull();
    const behind = listInstances(controller).filter(
      (row) => !row.is_controller && row.cursor === syncStatus(controller).head,
    );
    expect(behind.length).toBeGreaterThan(0);
  });

  it('sends its audit rows to the controller, which records them as the member’s', async () => {
    recordAudit({ action: 'pairing_tested', entityType: 'test', details: { n: 7 } });
    box.db.prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)').run(
      'audit',
      JSON.stringify({
        action: 'member_did',
        actor: 'pat',
        details: { ip: 'fd00:88::1' },
        at: '2026-11-01T10:00:00.000Z',
      }),
    );
    expect(
      controller.prepare("SELECT 1 FROM audit_log WHERE action = 'member_did'").get(),
    ).toBeUndefined();

    expect(await sendOutbox(box.db)).toBe(1);

    expect(box.db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(0);
    const row = controller.prepare("SELECT * FROM audit_log WHERE action = 'member_did'").get();
    expect(row).toMatchObject({ actor: 'pat', created_at: '2026-11-01 10:00:00' });
    expect(row.origin).toMatch(/^member:/);
    expect(JSON.parse(row.details)).toEqual({ ip: 'fd00:88::1' });
    // And the row comes back down with the next sync, as data of record.
    await syncOnce(box.db);
    expect(
      box.db.prepare("SELECT 1 FROM audit_log WHERE action = 'member_did'").get(),
    ).toBeDefined();
  });

  it('keeps sending when one waiting row names a user who is gone, or is not an audit row', async () => {
    const queue = box.db.prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)');
    queue.run(
      'audit',
      JSON.stringify({ action: 'by_a_ghost', userId: 987654, entityId: { odd: 1 } }),
    );
    queue.run('audit', 'not json');
    queue.run('audit', JSON.stringify({ action: 'after_the_ghost' }));

    expect(await sendOutbox(box.db)).toBe(3);

    expect(box.db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n).toBe(0);
    expect(
      controller
        .prepare("SELECT user_id, entity_id FROM audit_log WHERE action = 'by_a_ghost'")
        .get(),
    ).toEqual({ user_id: null, entity_id: null });
    expect(
      controller.prepare("SELECT 1 FROM audit_log WHERE action = 'after_the_ghost'").get(),
    ).toBeDefined();
  });

  it('does not let a member claim a cursor it cannot hold', async () => {
    const credential = fs.readFileSync(path.join(box.dir, 'sync', 'credential'), 'utf8').trim();
    const mine = () =>
      listInstances(controller).find(
        (row) =>
          row.instance_id ===
          box.db.prepare("SELECT value FROM sync_state WHERE key = 'instance_id'").get().value,
      );
    const before = mine().cursor;
    const { syncRequest } = await import('../../src/utils/sync-client.js');
    const local = syncStatus(controller);
    await syncRequest({
      address: '127.0.0.1',
      port,
      fingerprint: identity.fingerprint,
      credential,
      path: `/api/sync/changes?schema=${local.schema}&dataset=${local.dataset}&since=${local.head + 1_000_000}`,
    });
    expect(mine().cursor).toBe(before);
  });

  it('pauses when the two sides are on different schemas', async () => {
    box.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_MIGRATION + 1);
    const err = await syncOnce(box.db).catch((e) => e);
    expect(err.code).toBe('paused');
    expect(err.message).toMatch(/Update the older one/);
    box.db.prepare('DELETE FROM schema_version WHERE version = ?').run(LATEST_MIGRATION + 1);
  });

  it('starts over from a snapshot when the controller starts a new dataset', async () => {
    const { startNewDataset } = await import('../../src/sync/log.js');
    startNewDataset(controller);
    setSetting('map_home', '5,6');
    await syncOnce(box.db);
    expect(syncStatus(box.db).dataset).toBe(syncStatus(controller).dataset);
    expect(estate(box.db)).toEqual(estate(controller));
  });

  it('is turned away once the controller removes it', async () => {
    for (const row of listInstances(controller)) removeMember(controller, row.id);
    await expect(syncOnce(box.db)).rejects.toMatchObject({ code: 'unknown_member' });
  });
});
