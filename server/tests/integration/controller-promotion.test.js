/**
 * Changing the controller (docs/REDUNDANCY-PLAN.md, section 7): a forced
 * promotion, fencing, the old controller coming back and joining again, and
 * a coordinated handover with its cancel and its recoveries.
 *
 * Every instance is a database of its own with its own HTTPS server on its
 * sync identity and its own routes, all in one process
 * (tests/helpers/instance-estate.js). What a review of this code found is in
 * controller-promotion-findings.test.js.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/db/init.js', async (importOriginal) =>
  (await import('../helpers/instances.js')).perInstanceDb(await importOriginal()),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const {
  api,
  asController,
  box,
  changesFor,
  dataOfRecord,
  epochOf,
  estate,
  hello,
  reboot,
  rowOf,
  useEstates,
  write,
} = await import('../helpers/instance-estate.js');
const { LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { CONTROLLER, MEMBER, readSyncState, storedMode, syncStatus, writeSyncState } =
  await import('../../src/sync/log.js');
const { controllerOf, isFenced } = await import('../../src/sync/mode.js');
const { fencedState, handoverFreeze, setTakeoverNotice, takeoverNotice } =
  await import('../../src/sync/promotion-state.js');
const { followNewController, sendOutbox, startMemberSync, syncOnce } =
  await import('../../src/sync/member.js');
const { findController } = await import('../../src/sync/find-controller.js');
const { EPOCH_HEADER } = await import('../../src/sync/controller-call.js');
const { parseChanges } = await import('../../src/sync/changes.js');
const { readCredential } = await import('../../src/sync/credential.js');
const { uploadCollectedOnce } = await import('../../src/sync/collected-upload.js');
const { dhcpState, markDhcpReady, servesDhcpHere } = await import('../../src/sync/dhcp-active.js');
const { deliverTakeoverNotice, divergenceReportPath, preDemotionSnapshotPath, takeOverIfNamed } =
  await import('../../src/services/controller-promotion.js');
const { createJoinToken, removeMember } = await import('../../src/models/sync-instance.js');
const { readSetting, upsertSetting } = await import('../../src/models/setting.js');
const { recordAudit } = await import('../../src/services/audit.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');

useEstates();

const insertMetrics = (db) =>
  db
    .prepare(
      `INSERT INTO metrics (ts, dns_queries, dhcp_requests, dhcp4_client_msgs, blocklist_blocks)
       VALUES (?, 5, 1, 1, 0)`,
    )
    .run(Math.floor(Date.now() / 60_000) * 60);
const metricsFrom = (on, other) =>
  on.db.prepare('SELECT count(*) AS n FROM metrics WHERE instance_id = ?').get(other.id).n;

describe('a single box, and a controller nobody has replaced', () => {
  let c;
  let a;
  beforeAll(async () => {
    [c, a] = await estate('solo', 'solo-member');
  });

  it('reports no handover and no fencing, and takes changes', async () => {
    const alone = await box('alone');
    asController(alone);
    upsertSetting(alone.db, 'dhcp_enabled', 'true');
    expect(servesDhcpHere(alone.db)).toBe(true);
    expect(readSetting(alone.db, 'dhcp_active_instance')).toBeNull();
    const list = (await api(alone).get('/api/instances')).body;
    expect(list.mode).toBe('controller');
    expect(list.promotion).toEqual({ handover: null, fenced: null });
    // One box takes its own backups or none: nothing to warn of.
    expect(list.backups_off).toBe(false);
    expect(list.instances).toHaveLength(1);
    expect(list.instances[0]).toMatchObject({ is_controller: true, can_promote: false });
    expect((await api(alone).get('/api/features')).body.instance).toMatchObject({
      mode: 'controller',
      fenced: false,
      handover_to: null,
    });
    expect((await write(alone, '1,1')).status).toBe(200);
    expect((await api(alone).post('/api/instances/promote/cancel')).body.code).toBe('no_handover');
    expect((await api(alone).get('/api/instances/divergence-report')).status).toBe(404);
    expect(reboot(alone).started).toBeNull();
  });

  it('sends a member that names no epoch a delta, as before', async () => {
    upsertSetting(c.db, 'map_home', '2,2');
    const local = syncStatus(a.db);
    const query = new URLSearchParams({
      schema: local.schema,
      dataset: local.dataset,
      since: readSyncState(a.db, 'cursor'),
    });
    const response = await syncRequest({
      address: '127.0.0.1',
      port: c.port,
      fingerprint: c.identity.fingerprint,
      path: `/api/sync/changes?${query}`,
      credential: readCredential(a.db),
    });
    expect(response.status).toBe(200);
    expect(response.headers[EPOCH_HEADER]).toBe('1');
    expect(parseChanges(response.body).header).toMatchObject({ snapshot: false, epoch: 1 });
    await syncOnce(a.db);
    expect(readSetting(a.db, 'map_home')).toBe('2,2');
    expect(epochOf(c)).toBe(1);
    expect(isFenced(c.db)).toBe(false);
  });

  it('answers hello in each mode, to a credential of this estate only', async () => {
    const mine = readCredential(a.db);
    expect(await hello(c, mine)).toEqual({
      status: 200,
      body: {
        instance_id: c.id,
        name: 'solo',
        mode: 'controller',
        epoch: 1,
        dataset: syncStatus(c.db).dataset,
        dhcp: {
          active_instance_id: c.id,
          term: 0,
          here: servesDhcpHere(c.db),
          handover_from: null,
          handover_since: null,
        },
      },
    });
    expect((await hello(c, null)).status).toBe(401);
    expect((await hello(c, `cs1_${'x'.repeat(43)}`)).body.code).toBe('unknown_member');

    // A member answers too. It knows the caller by the hash in its own copy
    // of the list, here its own credential presented back to it.
    const fromMember = await hello(a, mine);
    expect(fromMember.status).toBe(200);
    expect(fromMember.body).toMatchObject({ instance_id: a.id, mode: 'member', epoch: 1 });
    expect((await hello(a, `cs1_${'y'.repeat(43)}`)).status).toBe(401);
    expect((await hello(a, null)).status).toBe(401);
    // A member that hears a higher epoch has nothing to give up.
    expect((await hello(a, mine, { [EPOCH_HEADER]: '9' })).status).toBe(200);
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(isFenced(a.db)).toBe(false);
  });

  it('removes a member, never the controller’s own row', () => {
    expect(removeMember(c.db, rowOf(c, c).id)).toBe(false);
    expect(removeMember(c.db, rowOf(c, a).id)).toBe(true);
  });
});

describe('a forced promotion', () => {
  let c;
  let a;
  let b;
  let dataset;
  beforeAll(async () => {
    [c, a, b] = await estate('ctl', 'alpha', 'beta');
    upsertSetting(c.db, 'dhcp_enabled', 'true');
    dataset = syncStatus(c.db).dataset;
  });

  it('is refused without the confirmation, on a controller, and before a first copy', async () => {
    const unconfirmed = await api(a).post('/api/instances/promote-self').send({});
    expect(unconfirmed.status).toBe(400);
    const onController = await api(c).post('/api/instances/promote-self').send({ confirm: true });
    expect(onController.status).toBe(409);
    expect(onController.body.code).toBe('not_member');

    const cursor = readSyncState(a.db, 'cursor');
    a.db.prepare("DELETE FROM sync_state WHERE key = 'cursor'").run();
    const early = await api(a).post('/api/instances/promote-self').send({ confirm: true });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('never_synced');
    writeSyncState(a.db, 'cursor', cursor);
    expect(storedMode(a.db)).toBe(MEMBER);
  });

  // An update migrates the member's copy with nobody checking it against the
  // controller's, so boot forgets the cursor: until the next sync, which the
  // controller refuses across schemas, this copy is nothing to take over with.
  it('is refused on a member that was updated to another schema and has not synced since', async () => {
    const cursor = readSyncState(a.db, 'cursor');
    a.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_MIGRATION + 1);
    expect(reboot(a).started).toBe('schema changed');
    await expect(syncOnce(a.db)).rejects.toMatchObject({
      code: 'paused',
      message: expect.stringMatching(
        new RegExp(
          `schema ${LATEST_MIGRATION}\\).*schema ${LATEST_MIGRATION + 1}\\). Update the older one`,
        ),
      ),
    });
    const skewed = await api(a).post('/api/instances/promote-self').send({ confirm: true });
    expect(skewed.status).toBe(409);
    expect(skewed.body.code).toBe('never_synced');
    expect(skewed.body.error).toMatch(/updated to another version and has not synced since/);
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(epochOf(c)).toBe(1);

    a.db.prepare('DELETE FROM schema_version WHERE version = ?').run(LATEST_MIGRATION + 1);
    expect(reboot(a).started).toBe('schema changed');
    await syncOnce(a.db);
    expect(Number(readSyncState(a.db, 'cursor'))).toBeGreaterThanOrEqual(Number(cursor));
    expect(dataOfRecord(a.db)).toEqual(dataOfRecord(c.db));
  });

  it('makes the member the controller at the next epoch, in the same dataset', async () => {
    expect(servesDhcpHere(c.db)).toBe(true);
    // Beta is a step behind alpha, and its measurements are with the controller.
    insertMetrics(b.db);
    expect(await uploadCollectedOnce(b.db)).toBe(1);
    expect(metricsFrom(c, b)).toBe(1);
    await syncOnce(b.db);
    upsertSetting(c.db, 'map_home', '1,1');
    await syncOnce(a.db);
    // Once more with nothing to take, so the controller knows how far alpha got.
    await syncOnce(a.db);
    // What no member ever receives.
    upsertSetting(c.db, 'subnet_name_template', 'lost-{cidr}');
    c.db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES ('late', 'h4sh', 'admin')")
      .run();
    c.db
      .prepare("INSERT INTO settings (key, value) VALUES ('blocklist_redirect_ip', '192.0.2.1')")
      .run();
    c.db.prepare("DELETE FROM settings WHERE key = 'blocklist_redirect_ip'").run();
    await c.unplug();

    const head = syncStatus(a.db).head;
    const response = await api(a).post('/api/instances/promote-self').send({ confirm: true });
    expect(response.status).toBe(200);
    // DHCP stays named on the old controller, which did not answer.
    expect(response.body).toEqual({
      restarting: true,
      dhcp: { active_instance_id: c.id, name: 'ctl', reachable: false },
    });

    expect(storedMode(a.db)).toBe(CONTROLLER);
    expect(controllerOf(a.db)).toBeNull();
    expect(readCredential(a.db)).toBeNull();
    expect(syncStatus(a.db)).toMatchObject({ epoch: 2, dataset });
    expect(syncStatus(a.db).head).toBeGreaterThan(head);
    expect(rowOf(a, a)).toMatchObject({ is_controller: 1, credential_hash: null });
    expect(rowOf(a, c)).toMatchObject({
      is_controller: 0,
      credential_hash: null,
      address: '127.0.0.1',
      port: c.port,
    });
    // DHCP stays with the instance that served, by name now.
    expect(readSetting(a.db, 'dhcp_active_instance')).toBe(c.id);
    expect(readSetting(a.db, 'dhcp_term')).toBeNull();
    expect(dhcpState(a.db)).toMatchObject({ active: c.id, here: false, term: 0 });
    expect(servesDhcpHere(a.db)).toBe(false);
    // The old controller did not answer: telling it is still owed.
    expect(takeoverNotice(a.db)).toMatchObject({ kind: 'fence', epoch: 2 });
    expect(
      a.db.prepare("SELECT actor FROM audit_log WHERE action = 'controller_promoted'").get(),
    ).toMatchObject({ actor: 'testadmin' });
    // A member was told at the join to take no backups: that is left alone,
    // and nobody could say what the dead controller's schedule was. The list says so.
    expect(readSetting(a.db, 'backup_schedule')).toBe('off');
    expect((await api(a).get('/api/instances')).body.backups_off).toBe(true);
    // The old controller's row counts as heard from at the takeover, so the
    // quiet rule can let the change log's deletes go in time (P6-09).
    expect(Date.parse(rowOf(a, c).last_contact_at)).toBeGreaterThan(Date.now() - 60_000);
    upsertSetting(a.db, 'backup_schedule', 'daily');
    expect((await api(a).get('/api/instances')).body.backups_off).toBe(false);
    upsertSetting(a.db, 'backup_schedule', 'off');
  });

  it('carries on logging from where its copy stopped when it boots as the controller', () => {
    const before = syncStatus(a.db);
    const logged = a.db.prepare('SELECT count(*) AS n FROM sync_log').get().n;
    expect(reboot(a)).toEqual({ dataset, started: null });
    expect(syncStatus(a.db)).toMatchObject({ dataset, epoch: 2, floor: before.floor });
    // Nothing of the copied log is gone, and the next change follows it.
    expect(a.db.prepare('SELECT count(*) AS n FROM sync_log').get().n).toBe(logged);
    const head = syncStatus(a.db).head;
    expect(head).toBeGreaterThanOrEqual(before.head);
    upsertSetting(a.db, 'map_home', '3,3');
    expect(syncStatus(a.db).head).toBe(head + 1);
  });

  it('is found and followed by the other member, with a delta from its own cursor', async () => {
    const cursor = Number(readSyncState(b.db, 'cursor'));
    const followed = await followNewController(b.db);
    expect(followed).toMatchObject({ instance_id: a.id, name: 'alpha', port: a.port, epoch: 2 });
    expect(controllerOf(b.db)).toMatchObject({ instance_id: a.id, epoch: 2 });
    // The dataset, the cursor and the credential are the ones it had.
    expect(Number(readSyncState(b.db, 'cursor'))).toBe(cursor);
    expect(syncStatus(b.db).dataset).toBe(dataset);

    const offered = await changesFor(b, a);
    expect(offered.header).toMatchObject({ snapshot: false, since: cursor, epoch: 2, dataset });
    await syncOnce(b.db);
    expect(readSetting(b.db, 'map_home')).toBe('3,3');
    expect(epochOf(b)).toBe(2);
    expect(dataOfRecord(b.db)).toEqual(dataOfRecord(a.db));
    // What the old controller never sent is not there.
    expect(readSetting(b.db, 'subnet_name_template')).toBeNull();
  });

  it('takes a change that reaches the member', async () => {
    expect((await write(a, '4,4')).status).toBe(200);
    await syncOnce(b.db);
    expect(readSetting(b.db, 'map_home')).toBe('4,4');
    expect((await write(b, '5,5')).body.code).toBe('member_read_only');
  });

  it('gets the member’s outbox and its measurements from where they stopped', async () => {
    // The row followNewController queued, and one more.
    recordAudit({ db: b.db, action: 'after_promotion', entityType: 'test' });
    expect(await sendOutbox(b.db)).toBe(2);
    const rows = a.db
      .prepare(
        "SELECT action, origin FROM audit_log WHERE action IN ('after_promotion', 'instance_followed_controller') ORDER BY action",
      )
      .all();
    expect(rows).toEqual([
      { action: 'after_promotion', origin: 'member:beta' },
      { action: 'instance_followed_controller', origin: 'member:beta' },
    ]);

    insertMetrics(b.db);
    // Only the new row goes: the one the old controller holds is not sent again.
    expect(await uploadCollectedOnce(b.db)).toBe(1);
    expect(metricsFrom(a, b)).toBe(1);
    expect(await uploadCollectedOnce(b.db)).toBe(0);
  });

  it('lets DHCP be moved off the dead controller, as a second and separate step', async () => {
    const moved = await api(a).post(`/api/instances/${rowOf(a, b).id}/dhcp`);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      active_instance_id: b.id,
      term: 1,
      handover: { from_instance_id: c.id, from_name: 'ctl' },
    });
    // Nobody serves while the dead controller owes its last leases.
    const unconfirmed = await api(a).post('/api/instances/dhcp/force').send({});
    expect(unconfirmed.status).toBe(400);
    const forced = await api(a).post('/api/instances/dhcp/force').send({ confirm: true });
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ active_instance_id: b.id, handover: null });
    await syncOnce(b.db);
    expect(dhcpState(b.db)).toMatchObject({ here: true, term: 1, handoverFrom: null });
  });

  describe('when the old controller comes back', () => {
    it('still takes changes until an instance of the new epoch reaches it', async () => {
      await c.listen();
      expect(isFenced(c.db)).toBe(false);
      expect((await write(c, '8,8')).status).toBe(200);
      expect(servesDhcpHere(c.db)).toBe(true);
    });

    it('fences itself when a member that follows the new controller says hello', async () => {
      // Beta's search asks every instance on its list, the old controller included.
      expect(await findController(b.db)).toBeNull();
      expect(controllerOf(b.db).instance_id).toBe(a.id);

      expect(isFenced(c.db)).toBe(true);
      expect(storedMode(c.db)).toBe(MEMBER);
      expect(controllerOf(c.db)).toBeNull();
      expect(fencedState(c.db)).toMatchObject({ epoch: 2, by_instance_id: a.id, by_name: 'alpha' });
      // Its own epoch is the one it ran at: it never claims the new one.
      expect(epochOf(c)).toBe(1);
    });

    it('refuses every change, with the reason and what to do', async () => {
      const refused = await write(c, '9,9');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('controller_fenced');
      expect(refused.body.error).toMatch(/alpha took over as the controller/);
      expect(readSetting(c.db, 'map_home')).toBe('8,8');
      expect(() => upsertSetting(c.db, 'map_home', '9,9')).toThrow(/read-only on a member/);
      for (const path of [
        '/api/instances/join-token',
        `/api/instances/${rowOf(c, b).id}/promote`,
      ]) {
        expect((await api(c).post(path)).body.code).toBe('controller_fenced');
      }
      // It cannot take the role back while the new controller answers (P6-04).
      const self = await api(c).post('/api/instances/promote-self').send({ confirm: true });
      expect(self.status).toBe(409);
      expect(self.body).toEqual({
        code: 'controller_reachable',
        error: 'alpha is answering as the controller. Join it instead of taking the role back.',
      });
      expect(isFenced(c.db)).toBe(true);
    });

    it('serves no DHCP, hands out no changes, and says it is fenced', async () => {
      expect(servesDhcpHere(c.db)).toBe(false);
      expect(dhcpState(c.db)).toMatchObject({ fenced: true, here: false });
      expect(await changesFor(b, c)).toEqual({ status: 409 });
      expect((await hello(c, readCredential(b.db))).body).toMatchObject({ mode: 'fenced' });

      const list = (await api(c).get('/api/instances')).body;
      expect(list.mode).toBe('member');
      expect(list.controller).toBeNull();
      expect(list.promotion.handover).toBeNull();
      expect(list.promotion.fenced).toMatchObject({
        by_name: 'alpha',
        told_by: 'beta',
        epoch: 2,
        report: true,
      });
      expect(list.backups_off).toBe(false);
      expect(Number.isNaN(Date.parse(list.promotion.fenced.since))).toBe(false);
      expect(list.instances.every((row) => row.can_promote === false)).toBe(true);
      expect((await api(c).get('/api/features')).body.instance).toMatchObject({
        mode: 'member',
        fenced: true,
        serves_dhcp: false,
        handover_to: null,
      });
    });

    it('has saved its database as it was', () => {
      const file = preDemotionSnapshotPath(c.db);
      expect(path.dirname(file)).toBe(path.join(c.dir, 'snapshots', 'pre-demotion'));
      expect(path.basename(file)).toMatch(/^cidrella-\d{8}T\d{9}Z\.db$/);
      expect(fencedState(c.db).snapshot).toBe(path.basename(file));
      const copy = new Database(file, { readonly: true });
      try {
        expect(copy.prepare("SELECT value FROM settings WHERE key = 'map_home'").get().value).toBe(
          '8,8',
        );
        expect(copy.prepare("SELECT 1 FROM users WHERE username = 'late'").get()).toBeTruthy();
        // A controller's copy: put back, it is a controller's database again.
        expect(copy.prepare("SELECT 1 FROM sync_state WHERE key = 'mode'").get()).toBeUndefined();
      } finally {
        copy.close();
      }
    });

    it('lists what the new controller never received, secrets masked', async () => {
      const response = await api(c).get('/api/instances/divergence-report');
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      const report = JSON.parse(response.text);
      expect(report).toEqual(JSON.parse(fs.readFileSync(divergenceReportPath(c.db), 'utf8')));
      expect(report.replaced_by).toEqual({ instance_id: a.id, name: 'alpha' });
      expect(report.epoch).toBe(2);
      // From the lower cursor of the instance named and the one that said so.
      expect(report.since).toBe(Math.min(rowOf(c, a).cursor, rowOf(c, b).cursor));
      expect(fencedState(c.db)).toMatchObject({ by_name: 'alpha', told_by: 'beta' });

      const of = (table, key) =>
        report.changes.find((change) => change.table === table && String(change.key) === key);
      expect(of('settings', 'subnet_name_template')).toMatchObject({
        operation: 'changed',
        row: { key: 'subnet_name_template', value: 'lost-{cidr}' },
      });
      expect(of('settings', 'blocklist_redirect_ip')).toMatchObject({
        operation: 'deleted',
        row: null,
      });
      const late = report.changes.find(
        (change) => change.table === 'users' && change.row?.username === 'late',
      );
      expect(late.row.password_hash).toBe('(secret)');
      expect(JSON.stringify(report)).not.toContain('h4sh');
      // The change made after it came back, before it was fenced.
      expect(of('settings', 'map_home').row.value).toBe('8,8');
      expect(report.counts.settings).toBeGreaterThanOrEqual(3);
      // What alpha had already taken is not in it.
      expect(report.changes.some((change) => change.table === 'sync_instances')).toBe(false);
    });

    it('is told by the new controller too, which then owes it nothing', async () => {
      expect(await deliverTakeoverNotice(a.db)).toBe('delivered');
      expect(takeoverNotice(a.db)).toBeNull();
      expect(await deliverTakeoverNotice(a.db)).toBe('none');
    });

    it('joins the new controller with a join token, and stays fenced when the join fails', async () => {
      const notFenced = await api(a)
        .post('/api/instances/rejoin')
        .send({ address: '127.0.0.1', port: a.port, token: 'x' });
      expect(notFenced.status).toBe(409);
      expect(notFenced.body.code).toBe('not_fenced');

      const forged = `cj1_${a.identity.fingerprint}_${'x'.repeat(43)}`;
      const refused = await api(c)
        .post('/api/instances/rejoin')
        .send({ address: '127.0.0.1', port: a.port, token: forged });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('token_refused');
      expect(isFenced(c.db)).toBe(true);
      expect(storedMode(c.db)).toBe(MEMBER);
      expect(epochOf(c)).toBe(1);

      const { token } = createJoinToken(a.db, { fingerprint: a.identity.fingerprint });
      const joined = await api(c)
        .post('/api/instances/rejoin')
        .send({ address: '127.0.0.1', port: a.port, token });
      expect(joined.status).toBe(200);
      expect(joined.body).toEqual({ controller: { name: 'alpha' }, restarting: true });

      expect(isFenced(c.db)).toBe(false);
      expect(storedMode(c.db)).toBe(MEMBER);
      expect(controllerOf(c.db)).toMatchObject({ instance_id: a.id, port: a.port });
      expect(epochOf(c)).toBe(2);
      a.db.prepare('UPDATE sync_instances SET port = ? WHERE instance_id = ?').run(c.port, c.id);
      await syncOnce(c.db);
      expect(dataOfRecord(c.db)).toEqual(dataOfRecord(a.db));
      expect(readSetting(c.db, 'subnet_name_template')).toBeNull();
      expect(rowOf(a, c)).toMatchObject({ is_controller: 0 });
      expect(rowOf(a, c).credential_hash).toBeTruthy();
      // The copy and the report from when it was fenced are still there.
      expect(fs.existsSync(preDemotionSnapshotPath(c.db))).toBe(true);
      expect((await api(c).get('/api/instances')).body.promotion.fenced).toBeNull();
      expect((await write(c, '9,9')).body.code).toBe('member_read_only');
    });

    it('can be removed by the new controller, whose own row cannot', async () => {
      expect((await api(a).delete(`/api/instances/${rowOf(a, a).id}`)).status).toBe(404);
      expect((await api(a).delete(`/api/instances/${rowOf(a, c).id}`)).status).toBe(204);
      expect(rowOf(a, c)).toBeUndefined();
    });
  });
});

describe('a member that served DHCP and takes over', () => {
  it('keeps serving, at the same term', async () => {
    const [c, a] = await estate('ctl-d', 'alpha-d');
    upsertSetting(c.db, 'dhcp_enabled', 'true');
    upsertSetting(c.db, 'dhcp_term', 1);
    upsertSetting(c.db, 'dhcp_active_instance', a.id);
    await syncOnce(a.db);
    markDhcpReady(a.db, 1);
    expect(servesDhcpHere(a.db)).toBe(true);
    await c.unplug();

    await api(a).post('/api/instances/promote-self').send({ confirm: true }).expect(200);

    expect(storedMode(a.db)).toBe(CONTROLLER);
    expect(readSetting(a.db, 'dhcp_active_instance')).toBe(a.id);
    expect(readSetting(a.db, 'dhcp_term')).toBe('1');
    expect(servesDhcpHere(a.db)).toBe(true);
  });
});

describe('a coordinated handover', () => {
  let c;
  let a;
  let b;
  let dataset;
  const promote = (from, to) => api(from).post(`/api/instances/${rowOf(from, to).id}/promote`);
  beforeAll(async () => {
    [c, a, b] = await estate('ctl-h', 'alpha-h', 'beta-h');
    upsertSetting(c.db, 'dhcp_enabled', 'true');
    upsertSetting(c.db, 'backup_schedule', 'weekly');
    upsertSetting(c.db, 'backup_retention_count', '14');
    dataset = syncStatus(c.db).dataset;
  });

  it('is offered for a member that is following, and refused otherwise', async () => {
    const list = (await api(c).get('/api/instances')).body;
    const rows = Object.fromEntries(list.instances.map((row) => [row.name, row]));
    expect(rows['alpha-h'].can_promote).toBe(true);
    expect(rows['ctl-h'].can_promote).toBe(false);
    expect((await api(a).get('/api/instances')).body.instances.some((row) => row.can_promote)).toBe(
      false,
    );

    expect((await api(c).post('/api/instances/9999/promote')).status).toBe(404);
    expect((await promote(a, b)).body.code).toBe('member_read_only');

    const contact = c.db.prepare('UPDATE sync_instances SET last_contact_at = ? WHERE id = ?');
    contact.run(new Date(Date.now() - 10 * 60_000).toISOString(), rowOf(c, a).id);
    const quiet = await promote(c, a);
    expect(quiet.status).toBe(409);
    expect(quiet.body.code).toBe('not_current');
    expect(quiet.body.error).toMatch(/alpha-h has not been in contact/);
    contact.run(new Date().toISOString(), rowOf(c, a).id);

    const schema = c.db.prepare('UPDATE sync_instances SET schema_version = ? WHERE id = ?');
    schema.run(LATEST_MIGRATION - 1, rowOf(c, a).id);
    const older = await promote(c, a);
    expect(older.status).toBe(409);
    expect(older.body.code).toBe('schema_mismatch');
    expect(older.body.error).toMatch(
      /^alpha-h runs \S+, not the controller's\. Update it to the same version first\.$/,
    );
    schema.run(LATEST_MIGRATION, rowOf(c, a).id);

    upsertSetting(c.db, 'dhcp_handover_from', b.id);
    const moving = await promote(c, a);
    expect(moving.status).toBe(409);
    expect(moving.body.code).toBe('dhcp_moving');
    c.db.prepare("DELETE FROM settings WHERE key = 'dhcp_handover_from'").run();

    expect(handoverFreeze(c.db)).toBeNull();
    expect(
      c.db
        .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'controller_handover_refused'")
        .get().n,
    ).toBe(3);
  });

  it('freezes the controller, which still sends its changes', async () => {
    const started = await promote(c, a);
    expect(started.status).toBe(200);
    expect(started.body.handover).toMatchObject({ to_instance_id: a.id, to_name: 'alpha-h' });
    expect(Number.isNaN(Date.parse(started.body.handover.since))).toBe(false);

    const frozen = await write(c, '1,1');
    expect(frozen.status).toBe(409);
    expect(frozen.body).toEqual({
      error: 'The controller is being handed over to alpha-h.',
      code: 'controller_handover',
    });
    expect((await promote(c, b)).body.code).toBe('handover_pending');
    expect((await api(c).post(`/api/instances/${rowOf(c, b).id}/dhcp`)).body.code).toBe(
      'controller_handover',
    );
    expect((await api(c).post('/api/instances/join-token')).body.code).toBe('controller_handover');
    expect((await api(c).get('/api/features')).body.instance).toMatchObject({
      mode: 'controller',
      fenced: false,
      handover_to: 'alpha-h',
    });
    expect((await api(c).get('/api/instances')).body.promotion.handover).toEqual(
      started.body.handover,
    );

    // The sync that carries the setting is not held up.
    await syncOnce(b.db);
    expect(readSetting(b.db, 'controller_handover_to')).toBe(a.id);
    expect((await api(b).get('/api/instances')).body.promotion.handover).toEqual(
      started.body.handover,
    );
    // Another member cannot jump the queue while the named one can still do it.
    const jump = await api(b).post('/api/instances/promote-self').send({ confirm: true });
    expect(jump.status).toBe(409);
    expect(jump.body.code).toBe('handover_pending');
    expect(jump.body.error).toMatch(/alpha-h is still reachable/);
    expect(storedMode(b.db)).toBe(MEMBER);
  });

  it('stays frozen across a restart of the controller', async () => {
    expect(reboot(c).started).toBeNull();
    expect((await write(c, '1,1')).body.code).toBe('controller_handover');
  });

  it('is called off: the controller takes changes again and the member does nothing', async () => {
    const cancelled = await api(c).post('/api/instances/promote/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ handover: null });
    expect((await api(c).post('/api/instances/promote/cancel')).body.code).toBe('no_handover');
    expect((await write(c, '1,1')).status).toBe(200);

    await syncOnce(a.db);
    expect(await takeOverIfNamed(a.db)).toBe(false);
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(epochOf(c)).toBe(1);
  });

  it('ends with the member as the controller and the old controller its member', async () => {
    await promote(c, a).expect(200);
    // Beta has not heard: it takes over nothing, and neither does alpha before it has.
    expect(await takeOverIfNamed(b.db)).toBe(false);
    expect(await takeOverIfNamed(a.db)).toBe(false);
    await syncOnce(a.db);
    expect(await takeOverIfNamed(a.db)).toBe(true);

    expect(storedMode(a.db)).toBe(CONTROLLER);
    expect(syncStatus(a.db)).toMatchObject({ epoch: 2, dataset });
    expect(readSetting(a.db, 'controller_handover_to')).toBeNull();
    expect(readSetting(a.db, 'dhcp_active_instance')).toBe(c.id);
    expect(takeoverNotice(a.db)).toBeNull();
    expect(rowOf(a, c).credential_hash).toBeTruthy();

    // The old controller is a member of it, by the credential it was handed.
    expect(storedMode(c.db)).toBe(MEMBER);
    expect(isFenced(c.db)).toBe(false);
    expect(handoverFreeze(c.db)).toBeNull();
    expect(controllerOf(c.db)).toMatchObject({
      instance_id: a.id,
      name: 'alpha-h',
      address: '127.0.0.1',
      port: a.port,
      fingerprint: a.identity.fingerprint,
    });
    expect(fs.statSync(path.join(c.dir, 'sync', 'credential')).mode & 0o777).toBe(0o600);
    // The backup schedule went with the role (P6-12).
    expect(readSetting(c.db, 'backup_schedule')).toBe('off');
    expect(readSetting(a.db, 'backup_schedule')).toBe('weekly');
    expect(readSetting(a.db, 'backup_retention_count')).toBe('14');
    expect((await api(a).get('/api/instances')).body.backups_off).toBe(false);
    expect(
      JSON.parse(
        a.db
          .prepare("SELECT details FROM audit_log WHERE action = 'controller_handover_completed'")
          .get().details,
      ),
    ).toMatchObject({ backup_schedule: 'weekly' });
    expect(fs.existsSync(divergenceReportPath(c.db))).toBe(false);

    // The new controller makes changes of its own before the old one asks:
    // their numbers in its log are ones the old controller must not have used.
    for (const value of ['7,7', '8,8', '9,9']) expect((await write(a, value)).status).toBe(200);
    // It carries on from its own head with a delta, and still serves DHCP.
    const offered = await changesFor(c, a);
    expect(offered.header).toMatchObject({ snapshot: false, epoch: 2, dataset });
    await syncOnce(c.db);
    expect(readSetting(c.db, 'map_home')).toBe('9,9');
    // Its own record of the handover reaches the new controller from its outbox.
    await sendOutbox(c.db);
    expect(
      a.db.prepare("SELECT 1 FROM audit_log WHERE action = 'controller_handed_over'").get(),
    ).toBeTruthy();
    await syncOnce(c.db);
    expect(dataOfRecord(c.db)).toEqual(dataOfRecord(a.db));
    expect(epochOf(c)).toBe(2);
    expect(servesDhcpHere(c.db)).toBe(true);
    expect(reboot(c).started).toBeNull();
    expect(Number(readSyncState(c.db, 'cursor'))).toBe(syncStatus(a.db).head);

    // Exactly one of them takes changes.
    expect((await write(c, '2,2')).body.code).toBe('member_read_only');
    expect((await write(a, '2,2')).status).toBe(200);
    expect(
      a.db.prepare("SELECT 1 FROM audit_log WHERE action = 'controller_handover_completed'").get(),
    ).toBeTruthy();
  });

  it('owes the old controller nothing more once it follows, or is taken off the list', async () => {
    const owed = {
      kind: 'handover',
      to: { instance_id: c.id, name: 'ctl-h', address: '127.0.0.1', port: c.port },
      credential: 'x',
      grant: 'y',
      epoch: 2,
      base: 0,
      since: new Date(Date.now() - 60_000).toISOString(),
    };
    setTakeoverNotice(a.db, owed);
    expect(await deliverTakeoverNotice(a.db)).toBe('dropped');
    expect(takeoverNotice(a.db)).toBeNull();

    setTakeoverNotice(a.db, { ...owed, to: { ...owed.to, instance_id: 'gone' } });
    expect(await deliverTakeoverNotice(a.db)).toBe('dropped');
    // Nothing is owed by a member, whatever its state says.
    setTakeoverNotice(b.db, owed);
    expect(await deliverTakeoverNotice(b.db)).toBe('none');
    setTakeoverNotice(b.db, null);
  });

  it('is followed by the other member, with a delta', async () => {
    expect(await followNewController(b.db)).toMatchObject({ instance_id: a.id, epoch: 2 });
    expect((await changesFor(b, a)).header).toMatchObject({ snapshot: false });
    await syncOnce(b.db);
    await syncOnce(c.db);
    expect(readSetting(b.db, 'map_home')).toBe('2,2');
    expect(dataOfRecord(b.db)).toEqual(dataOfRecord(a.db));
    expect(dataOfRecord(c.db)).toEqual(dataOfRecord(a.db));
  });

  it('is finished at boot by a member that died between taking over and saying so', async () => {
    // Back the other way: alpha hands over to the old controller.
    await promote(a, c).expect(200);
    await syncOnce(c.db);
    await a.unplug();
    expect(await takeOverIfNamed(c.db)).toBe(true);
    expect(storedMode(c.db)).toBe(CONTROLLER);
    expect(epochOf(c)).toBe(3);
    // Alpha never heard, and what it is owed is kept.
    expect(takeoverNotice(c.db)).toMatchObject({ kind: 'handover', epoch: 3 });
    expect(takeoverNotice(c.db).to.instance_id).toBe(a.id);
    expect(storedMode(a.db)).toBe(CONTROLLER);

    // Alpha restarts: it is still frozen, and waits.
    await a.listen();
    reboot(a);
    expect((await write(a, '3,3')).body.code).toBe('controller_handover');
    // The new controller boots and tells it.
    expect(reboot(c).started).toBeNull();
    expect(await deliverTakeoverNotice(c.db)).toBe('delivered');
    expect(takeoverNotice(c.db)).toBeNull();
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(controllerOf(a.db)).toMatchObject({ instance_id: c.id, port: c.port });
    await syncOnce(a.db);
    expect(dataOfRecord(a.db)).toEqual(dataOfRecord(c.db));
    expect((await write(a, '3,3')).body.code).toBe('member_read_only');
    expect((await write(c, '3,3')).status).toBe(200);
  });

  it('ends with one controller when the cancel and the takeover cross', async () => {
    expect(await followNewController(b.db)).toMatchObject({ instance_id: c.id, epoch: 3 });
    await syncOnce(b.db);
    await promote(c, b).expect(200);
    // Beta has the setting. The controller calls the handover off before
    // beta acts on it, and beta takes over all the same.
    await syncOnce(b.db);
    await api(c).post('/api/instances/promote/cancel').expect(200);
    expect((await write(c, '4,4')).status).toBe(200);
    expect(await takeOverIfNamed(b.db)).toBe(true);

    expect(storedMode(b.db)).toBe(CONTROLLER);
    expect(epochOf(b)).toBe(4);
    // The old controller heard the higher epoch on beta's call, and is fenced.
    expect(isFenced(c.db)).toBe(true);
    expect(fencedState(c.db)).toMatchObject({ by_name: 'beta-h', epoch: 4 });
    expect(takeoverNotice(b.db)).toBeNull();
    expect((await write(c, '5,5')).body.code).toBe('controller_fenced');
    expect((await write(b, '5,5')).status).toBe(200);
    // What it took after the cancel is in its report.
    const report = JSON.parse(fs.readFileSync(divergenceReportPath(c.db), 'utf8'));
    expect(
      report.changes.find((change) => change.table === 'settings' && change.key === 'map_home').row
        .value,
    ).toBe('4,4');
    // Alpha, a member of the fenced controller, finds beta.
    expect(await followNewController(a.db)).toMatchObject({ instance_id: b.id, epoch: 4 });
    await syncOnce(a.db);
    expect(dataOfRecord(a.db)).toEqual(dataOfRecord(b.db));
  });
});

describe('a controller with DHCP switched off, handed over', () => {
  it('leaves DHCP off: nobody starts serving because the controller changed', async () => {
    const [c, a] = await estate('ctl-off', 'alpha-off');
    upsertSetting(c.db, 'dhcp_enabled', 'false');
    expect(servesDhcpHere(c.db)).toBe(false);
    await api(c)
      .post(`/api/instances/${rowOf(c, a).id}/promote`)
      .expect(200);
    await syncOnce(a.db);
    expect(await takeOverIfNamed(a.db)).toBe(true);

    // DHCP is named on the new controller, whose own switch is off.
    expect(readSetting(a.db, 'dhcp_active_instance')).toBe(a.id);
    expect(servesDhcpHere(a.db)).toBe(false);
    await syncOnce(c.db);
    expect(storedMode(c.db)).toBe(MEMBER);
    expect(servesDhcpHere(c.db)).toBe(false);
    expect(
      a.db.prepare("SELECT 1 FROM audit_log WHERE action = 'dhcp_instance_kept_off'").get(),
    ).toBeTruthy();
  });
});

describe('a member that was a step ahead of the one that took over', () => {
  it('is sent everything, since it holds changes the new controller never had', async () => {
    const [c, a, b] = await estate('ctl-s', 'alpha-s', 'beta-s');
    upsertSetting(c.db, 'map_home', '6,6');
    await syncOnce(b.db);
    await c.unplug();
    await api(a).post('/api/instances/promote-self').send({ confirm: true }).expect(200);
    upsertSetting(a.db, 'subnet_name_template', 'new-{cidr}');
    // Beta's cursor is a number alpha's log has reached, for other changes.
    expect(Number(readSyncState(b.db, 'cursor'))).toBeLessThanOrEqual(syncStatus(a.db).head);

    expect(await followNewController(b.db)).toMatchObject({ instance_id: a.id });
    expect((await changesFor(b, a)).header).toMatchObject({ snapshot: true, epoch: 2 });
    await syncOnce(b.db);
    expect(readSetting(b.db, 'map_home')).toBeNull();
    expect(dataOfRecord(b.db)).toEqual(dataOfRecord(a.db));
    expect(epochOf(b)).toBe(2);
  });
});

describe('the members’ own sync loops', () => {
  it('take over when named, and follow the new controller, with nobody telling them', async () => {
    const [c, a, b] = await estate('ctl-l', 'alpha-l', 'beta-l');
    const stops = [
      startMemberSync(a.db, { onCurrent: takeOverIfNamed }),
      startMemberSync(b.db, { onCurrent: takeOverIfNamed }),
    ];
    try {
      await api(c)
        .post(`/api/instances/${rowOf(c, a).id}/promote`)
        .expect(200);
      await vi.waitFor(() => expect(storedMode(a.db)).toBe(CONTROLLER), { timeout: 40_000 });
      await vi.waitFor(() => expect(storedMode(c.db)).toBe(MEMBER), { timeout: 40_000 });
      expect(controllerOf(c.db).instance_id).toBe(a.id);

      // Beta asked the old controller, heard it is a member now, and looked.
      await vi.waitFor(() => expect(controllerOf(b.db).instance_id).toBe(a.id), {
        timeout: 40_000,
      });
      expect((await write(a, '7,7')).status).toBe(200);
      await vi.waitFor(() => expect(readSetting(b.db, 'map_home')).toBe('7,7'), {
        timeout: 40_000,
      });
      expect(epochOf(b)).toBe(2);
      expect(storedMode(b.db)).toBe(MEMBER);
    } finally {
      for (const stop of stops) stop();
    }
  }, 180_000);
});

describe('a controller that died mid-handover, with the member it named', () => {
  it('lets another member take over, and clears the handover', async () => {
    const [c, a, b] = await estate('ctl-x', 'alpha-x', 'beta-x');
    await api(c)
      .post(`/api/instances/${rowOf(c, a).id}/promote`)
      .expect(200);
    await syncOnce(b.db);
    expect(readSetting(b.db, 'controller_handover_to')).toBe(a.id);
    await c.unplug();

    // The named member still answers: refused.
    const refused = await api(b).post('/api/instances/promote-self').send({ confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('handover_pending');
    expect(refused.body.error).toMatch(/alpha-x is still reachable/);

    await a.unplug();
    await api(b).post('/api/instances/promote-self').send({ confirm: true }).expect(200);
    expect(storedMode(b.db)).toBe(CONTROLLER);
    expect(epochOf(b)).toBe(2);
    expect(readSetting(b.db, 'controller_handover_to')).toBeNull();
    expect(readSetting(b.db, 'controller_handover_since')).toBeNull();
    expect(takeoverNotice(b.db)).toMatchObject({ kind: 'fence' });
    const audit = b.db
      .prepare("SELECT details FROM audit_log WHERE action = 'controller_promoted'")
      .get();
    expect(JSON.parse(audit.details)).toMatchObject({
      forced: true,
      handover_to_unreachable: 'alpha-x',
    });
    // The named member comes back, never having taken over: it follows.
    await a.listen();
    expect(await takeOverIfNamed(a.db)).toBe(false);
    expect(await followNewController(a.db)).toMatchObject({ instance_id: b.id, epoch: 2 });
    await syncOnce(a.db);
    expect(readSetting(a.db, 'controller_handover_to')).toBeNull();
    expect(storedMode(a.db)).toBe(MEMBER);
  }, 120_000);
});
