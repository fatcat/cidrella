/**
 * Changing the controller, continued (tests/integration/controller-promotion.test.js
 * has the main paths): what a review of the promotion code found, one case
 * per finding. Each reproduces the sequence that went wrong.
 *
 * A file of its own because one file can join about 20 boxes
 * (tests/helpers/instance-estate.js).
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
  box,
  changesFor,
  dataOfRecord,
  epochOf,
  estate,
  hello,
  join,
  reboot,
  rowOf,
  useEstates,
  write,
} = await import('../helpers/instance-estate.js');
const { CONTROLLER, MEMBER, readSyncState, storedMode, syncStatus, writeSyncState } =
  await import('../../src/sync/log.js');
const { controllerOf, isFenced } = await import('../../src/sync/mode.js');
const { fencedState, handoverFreeze, setTakeoverNotice, takeoverNotice } =
  await import('../../src/sync/promotion-state.js');
const { followNewController, syncOnce } = await import('../../src/sync/member.js');
const { findController } = await import('../../src/sync/find-controller.js');
const { CONTROLLER_HEADER, EPOCH_HEADER } = await import('../../src/sync/controller-call.js');
const { readCredential } = await import('../../src/sync/credential.js');
const { dhcpState, markDhcpReady, servesDhcpHere } = await import('../../src/sync/dhcp-active.js');
const {
  deliverTakeoverNotice,
  divergenceReportPath,
  preDemotionSnapshotPath,
  setPromotionRestart,
  takeOverIfNamed,
} = await import('../../src/services/controller-promotion.js');
const { createJoinToken, lowestMemberCursor } = await import('../../src/models/sync-instance.js');
const { readSetting, upsertSetting } = await import('../../src/models/setting.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');

useEstates();

const promoteSelf = (one) => api(one).post('/api/instances/promote-self').send({ confirm: true });
const auditOf = (one, action) => {
  const row = one.db
    .prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id DESC')
    .get(action);
  return row ? JSON.parse(row.details) : null;
};
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const snapshotsOf = (one) => filesIn(path.join(one.dir, 'snapshots', 'pre-demotion'));
const reportsOf = (one) =>
  filesIn(path.join(one.dir, 'sync')).filter((name) => name.startsWith('divergence-report-'));

describe('a second forced promotion (P6-01)', () => {
  it('is refused while the member that took over first answers', async () => {
    const [c, a, b] = await estate('ctl-2', 'alpha-2', 'beta-2');
    await c.unplug();
    await promoteSelf(a).expect(200);
    const second = await promoteSelf(b);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      code: 'controller_reachable',
      error:
        'alpha-2 has taken over as the controller already. This member will follow it shortly.',
    });
    expect(storedMode(b.db)).toBe(MEMBER);
    expect(epochOf(b)).toBe(1);
    expect(await followNewController(b.db)).toMatchObject({ instance_id: a.id, epoch: 2 });

    // The dead controller's row counts as heard from at the takeover, so the
    // change log stops waiting for it once it has been quiet for 30 days (P6-09).
    await syncOnce(b.db);
    await syncOnce(b.db);
    expect(rowOf(a, c).last_contact_at).toBeTruthy();
    expect(lowestMemberCursor(a.db)).toBe(0);
    a.db
      .prepare('UPDATE sync_instances SET last_contact_at = ? WHERE instance_id = ?')
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), c.id);
    expect(lowestMemberCursor(a.db)).toBe(rowOf(a, b).cursor);
    // The notice it is still owed is not dropped for that stamp.
    expect(takeoverNotice(a.db)).toMatchObject({ kind: 'fence' });
  }, 30_000);

  it('sends everything to a member that moves between two controllers of one epoch', async () => {
    const [c, a, b, m] = await estate('ctl-5', 'alpha-5', 'beta-5', 'mu-5');
    await c.unplug();
    await promoteSelf(a).expect(200);
    // Beta cannot reach alpha, so nothing stops the second promotion: two
    // controllers at epoch 2, each with a log of its own from here.
    await a.unplug();
    await promoteSelf(b).expect(200);
    await a.listen();
    expect([epochOf(a), epochOf(b)]).toEqual([2, 2]);

    const first = await followNewController(m.db);
    const x = first.instance_id === a.id ? a : b;
    const y = x === a ? b : a;
    upsertSetting(x.db, 'map_home', 'only-on-x');
    // From the old controller's log to x's: a delta, as x carried that log on.
    expect((await changesFor(m, x)).header).toMatchObject({ snapshot: false });
    await syncOnce(m.db);
    expect(readSetting(m.db, 'map_home')).toBe('only-on-x');
    expect(epochOf(m)).toBe(2);
    expect(readSyncState(m.db, 'copy_from')).toBe(x.id);

    await x.unplug();
    for (let i = 0; i < 12; i++) upsertSetting(y.db, 'subnet_name_template', `y-${i}`);
    // The cursor is a number y's log has reached too, for other changes.
    expect(Number(readSyncState(m.db, 'cursor'))).toBeLessThanOrEqual(syncStatus(y.db).head);
    expect(await followNewController(m.db)).toMatchObject({ instance_id: y.id, epoch: 2 });
    // Same epoch number, another log: the cursor means nothing there.
    expect((await changesFor(m, y)).header).toMatchObject({ snapshot: true, epoch: 2 });
    await syncOnce(m.db);
    expect(readSetting(m.db, 'map_home')).toBe(readSetting(y.db, 'map_home'));
    expect(dataOfRecord(m.db)).toEqual(dataOfRecord(y.db));
    expect(readSyncState(m.db, 'copy_from')).toBe(y.id);
    // And from there it goes on with deltas.
    upsertSetting(y.db, 'map_home', 'on-y');
    expect((await changesFor(m, y)).header).toMatchObject({ snapshot: false });
  }, 60_000);
});

describe('a member the new controller never heard of (P6-02)', () => {
  it('learns there is a controller, cannot take the role, and joins it', async () => {
    const [c, a] = await estate('ctl-u', 'alpha-u');
    const d = await box('delta-u');
    await join(d, c);
    await syncOnce(d.db);
    // Alpha's copy is from before delta joined.
    await c.unplug();
    await promoteSelf(a).expect(200);
    expect(rowOf(a, d)).toBeUndefined();

    // Alpha does not know delta's credential, and says only its mode and epoch.
    const stranger = await hello(a, readCredential(d.db));
    expect(stranger.status).toBe(401);
    expect(await followNewController(d.db)).toBeNull();
    // That is enough to stop delta from becoming a second controller.
    const taken = await promoteSelf(d);
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({
      code: 'controller_reachable',
      error:
        'alpha-u is the controller now and does not know this instance. ' +
        'Join alpha-u with a join token from Settings > System > Instances.',
    });
    expect(storedMode(d.db)).toBe(MEMBER);

    // A join that fails leaves it the member it was, credential included.
    const credential = readCredential(d.db);
    const cursor = readSyncState(d.db, 'cursor');
    const forged = `cj1_${a.identity.fingerprint}_${'x'.repeat(43)}`;
    const refused = await api(d)
      .post('/api/instances/rejoin')
      .send({ address: '127.0.0.1', port: a.port, token: forged });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('token_refused');
    expect(controllerOf(d.db).instance_id).toBe(c.id);
    expect(readCredential(d.db)).toBe(credential);
    expect(readSyncState(d.db, 'cursor')).toBe(cursor);

    const { token } = createJoinToken(a.db, { fingerprint: a.identity.fingerprint });
    const joined = await api(d)
      .post('/api/instances/rejoin')
      .send({ address: '127.0.0.1', port: a.port, token });
    expect(joined.status).toBe(200);
    expect(joined.body).toEqual({ controller: { name: 'alpha-u' }, restarting: true });
    expect(controllerOf(d.db)).toMatchObject({ instance_id: a.id, port: a.port });
    expect(readCredential(d.db)).not.toBe(credential);
    expect(epochOf(d)).toBe(2);
    await syncOnce(d.db);
    expect(dataOfRecord(d.db)).toEqual(dataOfRecord(a.db));
    expect(rowOf(a, d)).toMatchObject({ is_controller: 0, name: 'delta-u' });
    // What it held of the dead controller's data was copied aside first, at each attempt.
    expect(snapshotsOf(d)).toHaveLength(2);

    // A controller joins nobody.
    const onController = await api(a)
      .post('/api/instances/rejoin')
      .send({ address: '127.0.0.1', port: a.port, token: 'x' });
    expect(onController.status).toBe(409);
    expect(onController.body.code).toBe('not_fenced');

    // A step that fails after the mode has changed still ends with the restart (P6-11).
    await a.unplug();
    const restarts = [];
    const undo = setPromotionRestart((reason) => restarts.push(reason));
    const realRm = fs.rmSync;
    const broken = vi.spyOn(fs, 'rmSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith(path.join('sync', 'credential'))) throw new Error('read-only');
      return realRm(file, ...rest);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await promoteSelf(d);
      expect(response.status).toBe(500);
      expect(storedMode(d.db)).toBe(CONTROLLER);
      expect(restarts).toEqual(['Took over as the controller']);
    } finally {
      broken.mockRestore();
      errors.mockRestore();
      undo();
    }
  }, 30_000);
});

describe('a member that was behind on DHCP and takes over (P6-03)', () => {
  it('writes down the instance that serves at the highest term anyone reports', async () => {
    const [c, a, b] = await estate('ctl-t', 'alpha-t', 'beta-t');
    upsertSetting(c.db, 'dhcp_active_instance', b.id);
    upsertSetting(c.db, 'dhcp_term', '1');
    await syncOnce(b.db);
    markDhcpReady(b.db, 1);
    expect(servesDhcpHere(b.db)).toBe(true);
    // Alpha never received the move: its copy says the controller serves, at term 0.
    expect(dhcpState(a.db)).toMatchObject({ active: c.id, term: 0 });
    expect((await hello(b, readCredential(a.db))).body.dhcp).toEqual({
      active_instance_id: b.id,
      term: 1,
      here: true,
      handover_from: null,
      handover_since: null,
    });
    await c.unplug();

    const promoted = await promoteSelf(a);
    expect(promoted.status).toBe(200);
    expect(promoted.body.dhcp).toEqual({
      active_instance_id: b.id,
      name: 'beta-t',
      reachable: true,
    });
    expect(readSetting(a.db, 'dhcp_active_instance')).toBe(b.id);
    expect(readSetting(a.db, 'dhcp_term')).toBe('1');
    expect(auditOf(a, 'controller_promoted')).toMatchObject({
      dhcp_instance: 'beta-t',
      dhcp_term: 1,
      dhcp_known_from: 'beta-t',
    });

    await followNewController(b.db);
    await syncOnce(b.db);
    expect(dhcpState(b.db)).toMatchObject({
      here: true,
      active: b.id,
      term: 1,
      handoverFrom: null,
    });
    expect(servesDhcpHere(b.db)).toBe(true);

    // A controller frozen for a handover waits for the member it named, and
    // for nobody else: a request naming another instance fences it (P6-08).
    await syncOnce(b.db);
    // The dead controller is still owed its notice, which holds a handover back.
    setTakeoverNotice(a.db, null);
    await api(a)
      .post(`/api/instances/${rowOf(a, b).id}/promote`)
      .expect(200);
    const other = await hello(a, readCredential(b.db), {
      [EPOCH_HEADER]: '3',
      [CONTROLLER_HEADER]: c.id,
    });
    expect(other.body.code).toBe('fenced');
    expect(fencedState(a.db)).toMatchObject({ by_name: 'ctl-t', told_by: 'beta-t' });
  }, 30_000);
});

describe('a controller, its members, and a fencing with no controller left (P6-04, P6-06)', () => {
  let c;
  let a;
  let b;
  const claim = (from, epoch, named) =>
    hello(c, readCredential(from.db), {
      [EPOCH_HEADER]: String(epoch),
      [CONTROLLER_HEADER]: named.id,
    });
  beforeAll(async () => {
    [c, a, b] = await estate('ctl-f', 'alpha-f', 'beta-f');
    // Alpha is further along than beta, by the controller's count.
    await syncOnce(a.db);
    upsertSetting(c.db, 'map_home', '9,9');
    await syncOnce(a.db);
    await syncOnce(a.db);
  });

  it('a forced promotion is refused while the controller the member follows still answers (P6-01)', async () => {
    const refused = await promoteSelf(a);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      code: 'controller_reachable',
      error:
        'ctl-f is still answering as the controller. Use Make controller on ctl-f to hand the role over.',
    });
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(epochOf(c)).toBe(1);
    expect(isFenced(c.db)).toBe(false);
  });

  it('a member that names no instance still gets a delta within the epoch (P6-01)', async () => {
    a.db.prepare("DELETE FROM sync_state WHERE key = 'copy_from'").run();
    upsertSetting(c.db, 'map_home', '9,8');
    expect((await changesFor(a, c)).header).toMatchObject({ snapshot: false });
    await syncOnce(a.db);
    expect(readSyncState(a.db, 'copy_from')).toBe(c.id);
  });

  it('a lease report from an instance that does not serve DHCP is refused before its body is read (P6-10)', async () => {
    expect(dhcpState(c.db).active).toBe(c.id);
    // Larger than any report this controller would read into memory.
    const response = await syncRequest({
      address: '127.0.0.1',
      port: c.port,
      fingerprint: c.identity.fingerprint,
      method: 'POST',
      path: '/api/sync/leases',
      credential: readCredential(a.db),
      headers: { 'content-type': 'application/gzip' },
      body: Buffer.alloc(17 * 1024 * 1024),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('not_dhcp_active');
  }, 30_000);

  it('refuses an epoch no promotion could have reached, on every route that takes one', async () => {
    const far = await hello(c, readCredential(b.db), {
      [EPOCH_HEADER]: String(Number.MAX_SAFE_INTEGER),
    });
    expect(far.status).toBe(400);
    expect(far.body.code).toBe('bad_request');
    expect((await claim(b, 1002, a)).status).toBe(400);
    for (const route of ['/api/sync/fence', '/api/sync/handover-done']) {
      const told = await syncRequest({
        address: '127.0.0.1',
        port: c.port,
        fingerprint: c.identity.fingerprint,
        method: 'POST',
        path: route,
        credential: readCredential(a.db),
        body: { epoch: Number.MAX_SAFE_INTEGER, base: 0, credential: `cs1_${'x'.repeat(43)}` },
      });
      expect(told.status).toBe(400);
    }
    expect(storedMode(c.db)).toBe(CONTROLLER);
    expect(isFenced(c.db)).toBe(false);
    expect(epochOf(c)).toBe(1);
  });

  it('records who said so beside who was named, and reports from the lower cursor', async () => {
    expect(rowOf(c, a).cursor).toBeGreaterThan(rowOf(c, b).cursor);
    // Beta names alpha, which never took over.
    const fencedBy = await claim(b, 2, a);
    expect(fencedBy.status).toBe(409);
    expect(fencedBy.body.code).toBe('fenced');
    expect(fencedState(c.db)).toMatchObject({
      epoch: 2,
      by_name: 'alpha-f',
      told_by: 'beta-f',
      told_by_instance_id: b.id,
    });
    const list = (await api(c).get('/api/instances')).body;
    expect(list.promotion.fenced).toMatchObject({ by_name: 'alpha-f', told_by: 'beta-f' });
    const audit = c.db
      .prepare("SELECT payload FROM sync_outbox WHERE payload LIKE '%controller_fenced%'")
      .get();
    expect(audit ?? auditOf(c, 'controller_fenced')).toBeTruthy();
    const report = JSON.parse(fs.readFileSync(divergenceReportPath(c.db), 'utf8'));
    expect(report.replaced_by).toEqual({ instance_id: a.id, name: 'alpha-f' });
    // Naming the member that was further along hides nothing.
    expect(report.since).toBe(rowOf(c, b).cursor);
    expect(
      report.changes.some((change) => change.table === 'settings' && change.key === 'map_home'),
    ).toBe(true);
  });

  it('takes the role back when nobody answers as a controller', async () => {
    expect((await write(c, '1,2')).body.code).toBe('controller_fenced');
    expect(storedMode(a.db)).toBe(MEMBER);
    expect(storedMode(b.db)).toBe(MEMBER);

    const back = await promoteSelf(c);
    expect(back.status).toBe(200);
    expect(back.body).toEqual({
      restarting: true,
      dhcp: { active_instance_id: c.id, name: 'ctl-f', reachable: true },
    });
    expect(storedMode(c.db)).toBe(CONTROLLER);
    expect(isFenced(c.db)).toBe(false);
    // Above its own epoch and the one it was fenced at.
    expect(epochOf(c)).toBe(3);
    // The instance named as having replaced it is owed the word, in case it
    // is a controller when it comes back. This one is a member: it just hears.
    // It answers, so it has heard already.
    expect(takeoverNotice(c.db)).toBeNull();
    expect(auditOf(c, 'controller_fence_told')).toMatchObject({ to: 'alpha-f', epoch: 3 });
    expect(auditOf(c, 'controller_taken_back')).toMatchObject({
      epoch: 3,
      fenced_by: 'alpha-f',
      fenced_at_epoch: 2,
    });
    expect(reboot(c).started).toBeNull();
    expect((await write(c, '1,2')).status).toBe(200);
    expect((await api(c).get('/api/instances')).body.promotion.fenced).toBeNull();

    // Its members carry on from their cursors: it is the log they copied.
    expect((await changesFor(a, c)).header).toMatchObject({ snapshot: false, epoch: 3 });
    await syncOnce(a.db);
    await syncOnce(b.db);
    expect(readSetting(a.db, 'map_home')).toBe('1,2');
    expect(epochOf(a)).toBe(3);
    expect(dataOfRecord(a.db)).toEqual(dataOfRecord(c.db));
    expect(dataOfRecord(b.db)).toEqual(dataOfRecord(c.db));
  });

  it('tells the controller that had replaced it, once that one is back', async () => {
    const [x, y] = await estate('ctl-t', 'alpha-t');
    await x.unplug();
    await promoteSelf(y).expect(200);
    await x.listen();
    expect(await deliverTakeoverNotice(y.db)).toBe('delivered');
    expect(isFenced(x.db)).toBe(true);

    // The one that took over is lost; the old controller takes the role back.
    await y.unplug();
    await promoteSelf(x).expect(200);
    expect(storedMode(x.db)).toBe(CONTROLLER);
    expect(epochOf(x)).toBe(3);
    expect(await deliverTakeoverNotice(x.db)).toBe('pending');

    // It comes back still believing it is the controller, at the lower epoch.
    await y.listen();
    expect(storedMode(y.db)).toBe(CONTROLLER);
    expect(await deliverTakeoverNotice(x.db)).toBe('delivered');
    expect(isFenced(y.db)).toBe(true);
    expect(fencedState(y.db)).toMatchObject({ epoch: 3, by_name: 'ctl-t' });
    expect(takeoverNotice(x.db)).toBeNull();
    expect((await write(y, '5,5')).body.code).toBe('controller_fenced');
    expect((await write(x, '5,5')).status).toBe(200);
  });

  it('keeps the copy and the report of an earlier fencing when it is fenced again', async () => {
    expect(snapshotsOf(c)).toHaveLength(1);
    expect(reportsOf(c)).toHaveLength(1);
    const [firstSnapshot] = snapshotsOf(c);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await claim(b, 4, b)).body.code).toBe('fenced');
    expect(fencedState(c.db)).toMatchObject({ epoch: 4, by_name: 'beta-f', told_by: 'beta-f' });
    expect(snapshotsOf(c)).toHaveLength(2);
    expect(reportsOf(c)).toHaveLength(2);
    expect(snapshotsOf(c)).toContain(firstSnapshot);
    // The newest is what the download and the rejoin go by.
    expect(path.basename(preDemotionSnapshotPath(c.db))).toBe(snapshotsOf(c)[1]);
    expect(fencedState(c.db).snapshot).toBe(snapshotsOf(c)[1]);
    const served = JSON.parse((await api(c).get('/api/instances/divergence-report')).text);
    expect(served.epoch).toBe(4);
    // No more than three of each are kept.
    for (const epoch of [6, 8, 10]) {
      await promoteSelf(c).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await claim(b, epoch, b);
    }
    expect(snapshotsOf(c)).toHaveLength(3);
    expect(reportsOf(c)).toHaveLength(3);
    expect(snapshotsOf(c)).not.toContain(firstSnapshot);
  });
});

describe('a handover after the controller wrote something more (P6-05, P6-07)', () => {
  it('keeps a copy of the database, and refuses to give its data up when it can keep nothing', async () => {
    const [c, a] = await estate('ctl-w', 'alpha-w');
    await api(c)
      .post(`/api/instances/${rowOf(c, a).id}/promote`)
      .expect(200);
    await syncOnce(a.db);
    // What a frozen controller's own jobs still write.
    c.db
      .prepare(
        "INSERT INTO users (username, password_hash, role) VALUES ('made-while-frozen', 'h', 'readonly')",
      )
      .run();
    // Neither the copy nor the report can be written.
    fs.mkdirSync(path.join(c.dir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'snapshots', 'pre-demotion'), 'in the way');
    const realWrite = fs.writeFileSync;
    const noReport = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      if (String(file).includes('divergence-report-')) throw new Error('disk full');
      return realWrite(file, ...rest);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverIfNamed(a.db)).toBe(true);
      // The new controller is not heard: the old one stays as it was.
      expect(takeoverNotice(a.db)).toMatchObject({ kind: 'handover' });
      expect(storedMode(c.db)).toBe(CONTROLLER);
      expect(handoverFreeze(c.db)).toMatchObject({ to_instance_id: a.id });
      expect(readCredential(c.db)).toBeNull();
      expect(await deliverTakeoverNotice(a.db)).toBe('pending');
    } finally {
      noReport.mockRestore();
      errors.mockRestore();
    }

    fs.rmSync(path.join(c.dir, 'snapshots', 'pre-demotion'));
    expect(await deliverTakeoverNotice(a.db)).toBe('delivered');
    expect(storedMode(c.db)).toBe(MEMBER);
    expect(isFenced(c.db)).toBe(false);
    expect(snapshotsOf(c)).toHaveLength(1);
    const copy = new Database(preDemotionSnapshotPath(c.db), { readonly: true });
    try {
      expect(
        copy.prepare("SELECT 1 FROM users WHERE username = 'made-while-frozen'").get(),
      ).toBeTruthy();
    } finally {
      copy.close();
    }
    const report = JSON.parse(fs.readFileSync(divergenceReportPath(c.db), 'utf8'));
    expect(report.changes.some((change) => change.row?.username === 'made-while-frozen')).toBe(
      true,
    );
    // It starts over from everything the new controller has.
    expect(readSyncState(c.db, 'cursor')).toBeNull();
    await syncOnce(c.db);
    expect(
      c.db.prepare("SELECT 1 FROM users WHERE username = 'made-while-frozen'").get(),
    ).toBeUndefined();
    expect(dataOfRecord(c.db)).toEqual(dataOfRecord(a.db));
  }, 30_000);
});

describe('a handover whose notice is late (P6-08)', () => {
  const lateHandover = async (...names) => {
    const [c, a, b] = await estate(...names);
    await api(c)
      .post(`/api/instances/${rowOf(c, a).id}/promote`)
      .expect(200);
    await syncOnce(a.db);
    // The old controller misses the notice.
    await c.unplug();
    expect(await takeOverIfNamed(a.db)).toBe(true);
    expect(takeoverNotice(a.db)).toMatchObject({ kind: 'handover' });
    await c.listen();
    // The other member follows the new controller, and asks every instance.
    expect(await followNewController(b.db)).toMatchObject({ instance_id: a.id });
    return [c, a, b];
  };

  it('is waited for: a member naming the handover’s target does not fence the old controller', async () => {
    const [c, a, b] = await lateHandover('ctl-8', 'alpha-8', 'beta-8');
    const asked = await hello(c, readCredential(b.db), {
      [EPOCH_HEADER]: '2',
      [CONTROLLER_HEADER]: a.id,
    });
    expect(asked.status).toBe(409);
    expect(asked.body).toEqual({
      error: 'This controller is handing over to alpha-8 and waits to hear from it.',
      code: 'not_controller',
    });
    expect(await findController(b.db)).toBeNull();
    expect(storedMode(c.db)).toBe(CONTROLLER);
    expect(isFenced(c.db)).toBe(false);
    expect(handoverFreeze(c.db)).toMatchObject({ to_instance_id: a.id });

    // The notice arrives, with the credential made for it.
    expect(await deliverTakeoverNotice(a.db)).toBe('delivered');
    expect(storedMode(c.db)).toBe(MEMBER);
    expect(isFenced(c.db)).toBe(false);
    expect(controllerOf(c.db)).toMatchObject({ instance_id: a.id });
    expect(readCredential(c.db)).toBeTruthy();
    expect(auditOf(a, 'controller_handover_completed')).toBeTruthy();
    await syncOnce(c.db);
    expect(dataOfRecord(c.db)).toEqual(dataOfRecord(a.db));
  }, 30_000);

  it('is not waited for after five minutes', async () => {
    const [c, , b] = await lateHandover('ctl-9', 'alpha-9', 'beta-9');
    const freeze = handoverFreeze(c.db);
    writeSyncState(
      c.db,
      'handover',
      JSON.stringify({ ...freeze, since: new Date(Date.now() - 6 * 60_000).toISOString() }),
    );
    expect(await findController(b.db)).toBeNull();
    expect(isFenced(c.db)).toBe(true);
    expect(fencedState(c.db)).toMatchObject({ by_name: 'alpha-9', told_by: 'beta-9' });
  }, 60_000);
});
