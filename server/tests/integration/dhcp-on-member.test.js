/**
 * DHCP served by one chosen instance, which may be a member
 * (docs/REDUNDANCY-PLAN.md, sections 4 and 7): the lease report over the
 * pinned HTTPS connection, the moves, and what happens when a step is cut
 * short. A controller and two members, three databases in one process, as in
 * sync-pairing.test.js; the DHCP server is the fake backend, shared by all
 * three, so what each box did to "its" server is read from the calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';
import request from 'supertest';

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { freePort } = await import('../helpers/free-port.js');
const { backend } = await import('../../src/backends/index.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { default: instanceRoutes } = await import('../../src/routes/instances.js');
const { default: featuresRoutes } = await import('../../src/routes/features.js');
const { actorMiddleware } = await import('../../src/utils/request-actor.js');
const { afterCommitMiddleware } = await import('../../src/utils/after-commit.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { joinController, syncOnce } = await import('../../src/sync/member.js');
const { readCredential } = await import('../../src/sync/credential.js');
const { syncHead, writeSyncState } = await import('../../src/sync/log.js');
const { createJoinToken, ensureOwnInstance, ownInstanceId } =
  await import('../../src/models/sync-instance.js');
const { upsertSetting } = await import('../../src/models/setting.js');
const { SERVICE_STATES } = await import('../../src/services/instance-services.js');
const { dnsInstances: dnsInstancesOf } = await import('../../src/models/sync-instance.js');
const { memberSink, setFactsSink } = await import('../../src/sync/facts.js');
const { localSink } = await import('../../src/sync/local-sink.js');
const { stopRemoteSink } = await import('../../src/sync/remote-sink.js');
const { dhcpState, holdsDhcp, markDhcpReady, servesDhcpHere } =
  await import('../../src/sync/dhcp-active.js');
const { onLeaseReportRetry, reportLeases, stopLeaseReports } =
  await import('../../src/sync/lease-report.js');
const { LEASE_REPORT_TYPE, packReport } = await import('../../src/sync/lease-wire.js');
const { clearReleases, queuedReleases } = await import('../../src/sync/dhcp-release-queue.js');
const { releaseLeaseAnywhere } = await import('../../src/services/dhcp-release.js');
const { followDhcp } = await import('../../src/services/dhcp-follow.js');
const { syncLeasesNow } = await import('../../src/services/dhcp-lease-sync.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { activeLeaseSql, isLeaseActive } = await import('../../src/utils/lease-sql.js');

let controller;
let controllerDir;
let identity;
let server;
let port;
let app;
let twin;
let a;
let b;
let controllerRow;
let leasePosts = 0;
const tmpDirs = [];

const EXPIRES = new Date(Date.now() + 6 * 3600_000).toISOString();
const v4 = (ip, mac, hostname = null) => ({
  ip,
  mac,
  hostname,
  clientId: null,
  expiresAt: EXPIRES,
  dhcpVersion: 4,
  duid: null,
  iaid: null,
});
const v6 = (ip, duid, hostname = null) => ({
  ip,
  mac: null,
  hostname,
  clientId: null,
  expiresAt: EXPIRES,
  dhcpVersion: 6,
  duid,
  iaid: 1,
});
const duid = (n) => `00:01:00:01:00:00:00:${n}`;
const mac = (n) => `aa:bb:cc:00:00:${n}`;

function network(cidr, networkAddress, family, pool, v6Mode = null) {
  const subnetId = controller
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, status, address_family, domain_name)
       VALUES (?, ?, ?, NULL, ?, '256', 'allocated', ?, 'example.test')`,
    )
    .run(cidr, cidr, networkAddress, Number(cidr.split('/')[1]), family).lastInsertRowid;
  const typeId = controller
    .prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'")
    .get().id;
  const rangeId = controller
    .prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, ?, ?)')
    .run(subnetId, typeId, ...pool).lastInsertRowid;
  const scopeId = controller
    .prepare(
      `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode)
       VALUES (?, ?, '1h', ?, ?)`,
    )
    .run(rangeId, subnetId, family, v6Mode).lastInsertRowid;
  controller
    .prepare(
      'INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip) VALUES (?, ?, ?, ?)',
    )
    .run(scopeId, rangeId, ...pool);
  return subnetId;
}

async function join(name) {
  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  ensureSyncIdentity(tmpDir);
  writeSyncState(db, 'instance_name', name);
  const { token } = createJoinToken(controller, { fingerprint: identity.fingerprint });
  await joinController(db, { address: '127.0.0.1', port, token }, { restart: () => {} });
  const instanceId = ownInstanceId(db);
  const row = controller
    .prepare('SELECT id FROM sync_instances WHERE instance_id = ?')
    .get(instanceId).id;
  return { db, name, instanceId, row };
}

// A member hears from the controller and does what the settings call for.
async function catchUp(box) {
  await syncOnce(box.db);
  await followDhcp(box.db);
}
const admin = () => request(app);
// A member's sync loop asks every few seconds, which is how the controller
// knows a member is following. These tests step each sync by hand, so the
// controller is told the members are at its head before a move is asked for.
const reportIn = () =>
  controller
    .prepare('UPDATE sync_instances SET cursor = ? WHERE is_controller = 0')
    .run(syncHead(controller));
const move = async (row) => {
  reportIn();
  return admin().post(`/api/instances/${row}/dhcp`);
};
// The leases the controller holds as active. One a report no longer lists
// stays in the table, expired, for the offline window (replaceLeases).
const stored = () =>
  controller
    .prepare(`SELECT ip_address FROM dhcp_leases WHERE ${activeLeaseSql()} ORDER BY ip_address`)
    .all();
const audits = (action) =>
  controller.prepare('SELECT details FROM audit_log WHERE action = ?').all(action);
const post = (box, body, { raw = null, type = LEASE_REPORT_TYPE } = {}) =>
  syncRequest({
    address: '127.0.0.1',
    port,
    fingerprint: identity.fingerprint,
    method: 'POST',
    path: '/api/sync/leases',
    credential: readCredential(box.db),
    headers: { 'content-type': type },
    body: raw ?? packReport(body),
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body.toString('utf8')),
  }));

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  enableIpv6(controller);
  upsertSetting(controller, 'dhcp_enabled', 'true');
  identity = ensureSyncIdentity(controllerDir);
  port = await freePort({ tcp: true });
  ensureOwnInstance(controller, {
    fingerprint: identity.fingerprint,
    port,
    version: 'test',
    dnsAddresses: ['10.9.0.1', 'fd00:9::1'],
  });
  controllerRow = controller
    .prepare('SELECT id FROM sync_instances WHERE is_controller = 1')
    .get().id;

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path === '/api/sync/leases') leasePosts++;
    req.user = { id: 1, role: 'admin', username: 'testadmin' };
    next();
  });
  app.use(actorMiddleware);
  app.use(afterCommitMiddleware);
  app.use('/api/sync', syncRoutes);
  app.use('/api/instances', instanceRoutes);
  app.use('/api/features', featuresRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const net4 = network('10.9.0.0/24', '10.9.0.0', 4, ['10.9.0.100', '10.9.0.200']);
  const net6 = network('fd00:9::/64', 'fd00:9::', 6, ['fd00:9::100', 'fd00:9::1ff'], 'stateful');
  network('10.50.0.0/16', '10.50.0.0', 4, ['10.50.0.10', '10.50.19.250']);
  network('fd00:50::/64', 'fd00:50::', 6, ['fd00:50::1000', 'fd00:50::ffff'], 'stateful');
  controller
    .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)")
    .run();
  const reserve4 = controller.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, enabled, address_family)
     VALUES (?, ?, ?, ?, 1, 4)`,
  );
  const reserve6 = controller.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, duid, iaid, ip_address, hostname, enabled, address_family)
     VALUES (?, ?, 1, ?, ?, 1, 6)`,
  );
  reserve4.run(net4, mac('02'), '10.9.0.50', 'printer');
  reserve6.run(net6, duid('02'), 'fd00:9::50', 'printer6');
  reserve4.run(net4, mac('0a'), '10.9.0.60', null);
  reserve6.run(net6, duid('0a'), 'fd00:9::60', null);
  invalidateSubnetCache();

  backend.dhcp.importLeases = vi.fn(async (leases) => ({ added: leases.length, failed: [] }));
  backend.activate = vi.fn(async ({ force = false } = {}) => (force ? 'restarted' : 'unchanged'));
  backend.seedLeases([]);

  a = await join('member-a');
  b = await join('member-b');
});
afterAll(async () => {
  stopRemoteSink();
  stopLeaseReports();
  clearReleases();
  twin?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupTestDb(controllerDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  stopLeaseReports();
});

describe('what each instance serves', () => {
  const rowsByName = async () =>
    Object.fromEntries(
      (await admin().get('/api/instances')).body.instances.map((row) => [row.name, row]),
    );

  const controllerListRow = async () =>
    (await admin().get('/api/instances')).body.instances.find((row) => row.is_controller);

  it('shows the controller its own servers live, DHCP off once it is switched off', async () => {
    expect(await controllerListRow()).toMatchObject({
      dns_state: 'serving',
      dhcp_state: 'serving',
    });
    upsertSetting(controller, 'dhcp_enabled', 'false');
    try {
      expect(await controllerListRow()).toMatchObject({
        dhcp: 'serving',
        dhcp_state: 'off',
      });
    } finally {
      upsertSetting(controller, 'dhcp_enabled', 'true');
    }
  });

  it('says which DNS-serving instances DHCP clients are given', async () => {
    const { dns_handed_out: handedOut } = (await admin().get('/api/instances')).body;
    expect(handedOut.limit).toBe(3);
    expect(handedOut.left_out).toEqual([]);
    expect(handedOut.served).toEqual(
      dnsInstancesOf(controller)
        .slice(0, 3)
        .map((instance) => instance.name),
    );
  });

  it('keeps what a member reports with its sync, and drops it once the member is out of contact', async () => {
    await syncOnce(a.db);
    const reported = (await rowsByName())['member-a'];
    expect(SERVICE_STATES).toContain(reported.dns_state);
    expect(SERVICE_STATES).toContain(reported.dhcp_state);
    const stored = controller
      .prepare('SELECT dns_state, dhcp_state, last_contact_at FROM sync_instances WHERE name = ?')
      .get('member-a');
    expect(stored).toMatchObject({
      dns_state: reported.dns_state,
      dhcp_state: reported.dhcp_state,
    });
    controller
      .prepare('UPDATE sync_instances SET last_contact_at = ? WHERE name = ?')
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), 'member-a');
    try {
      expect((await rowsByName())['member-a']).toMatchObject({ dns_state: null, dhcp_state: null });
    } finally {
      controller
        .prepare('UPDATE sync_instances SET last_contact_at = ? WHERE name = ?')
        .run(stored.last_contact_at, 'member-a');
    }
  });
});

describe('moving DHCP from the controller to a member', () => {
  it('reports one instance serving, the controller, before anything moves', async () => {
    reportIn();
    const list = (await admin().get('/api/instances')).body;
    expect(list.dhcp).toEqual({
      active_instance_id: ownInstanceId(controller),
      term: 0,
      handover: null,
    });
    const rows = Object.fromEntries(list.instances.map((row) => [row.name, row]));
    expect(rows['member-a']).toMatchObject({ dhcp: null, can_take_dhcp: true });
    expect(list.instances.find((row) => row.is_controller)).toMatchObject({
      dhcp: 'serving',
      can_take_dhcp: false,
    });
    expect((await admin().get('/api/features')).body.instance.serves_dhcp).toBe(true);
  });

  it('refuses an unknown row, the instance that has it, one out of contact and one on another schema', async () => {
    expect((await move(9999)).status).toBe(404);
    const active = await move(controllerRow);
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('already_active');

    const contact = controller.prepare(
      'UPDATE sync_instances SET last_contact_at = ? WHERE id = ?',
    );
    contact.run(new Date(Date.now() - 10 * 60_000).toISOString(), a.row);
    const quiet = await move(a.row);
    expect(quiet.status).toBe(409);
    expect(quiet.body).toMatchObject({ code: 'not_current' });
    expect(quiet.body.error).toMatch(/member-a has not been in contact/);
    contact.run(new Date().toISOString(), a.row);

    const schema = controller.prepare('UPDATE sync_instances SET schema_version = ? WHERE id = ?');
    schema.run(LATEST_MIGRATION - 1, a.row);
    const older = await move(a.row);
    expect(older.status).toBe(409);
    expect(older.body.code).toBe('schema_mismatch');
    expect(older.body.error).toMatch(
      /^member-a runs .+, not the controller's\. Update it to the same version first\.$/,
    );
    schema.run(LATEST_MIGRATION, a.row);

    expect(dhcpState(controller).term).toBe(0);
    expect(audits('dhcp_instance_move_refused').map((row) => JSON.parse(row.details).code)).toEqual(
      ['already_active', 'not_current', 'schema_mismatch'],
    );
  });

  it('refuses a member that is in contact but has not caught up', async () => {
    const behind = controller.prepare('UPDATE sync_instances SET cursor = ? WHERE id = ?');
    for (const cursor of [null, syncHead(controller) - 100_000]) {
      behind.run(cursor, a.row);
      const response = await admin().post(`/api/instances/${a.row}/dhcp`);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('not_current');
      expect(response.body.error).toMatch(/has not caught up/);
    }
  });

  it('moves nothing when the controller cannot read its own final leases', async () => {
    const readLeases = backend.dhcp.readLeases;
    backend.dhcp.readLeases = async () => {
      throw new Error('lease file unreadable');
    };
    const response = await move(a.row);
    backend.dhcp.readLeases = readLeases;
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('move_failed');
    expect(dhcpState(controller)).toMatchObject({ term: 0, here: true });
    expect(servesDhcpHere(controller)).toBe(true);
    expect(audits('dhcp_instance_move_failed')).toHaveLength(1);
  });

  it('stops the controller with its last leases stored, and starts the member with them', async () => {
    backend.seedLeases([v4('10.9.0.110', mac('11'), 'early'), v6('fd00:9::110', duid('11'))]);
    await syncOnce(a.db);
    const response = await move(a.row);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active_instance_id: a.instanceId, term: 1, handover: null });
    // The final read happened inside the move: both leases are in the table.
    expect(stored().map((row) => row.ip_address)).toEqual(['10.9.0.110', 'fd00:9::110']);
    expect(servesDhcpHere(controller)).toBe(false);
    expect(holdsDhcp(controller)).toBe(false);
    expect(audits('dhcp_instance_moved')).toHaveLength(1);

    // The member has heard nothing yet, then hears, loads the leases and serves.
    expect(servesDhcpHere(a.db)).toBe(false);
    backend.dhcp.importLeases.mockClear();
    await catchUp(a);
    expect(backend.dhcp.importLeases).toHaveBeenCalledTimes(1);
    expect(backend.dhcp.importLeases.mock.calls[0][0].map((lease) => lease.ip).sort()).toEqual([
      '10.9.0.110',
      'fd00:9::110',
    ]);
    expect(servesDhcpHere(a.db)).toBe(true);
    expect(servesDhcpHere(b.db)).toBe(false);

    const list = (await admin().get('/api/instances')).body;
    const rows = Object.fromEntries(list.instances.map((row) => [row.name, row]));
    expect(rows['member-a']).toMatchObject({ dhcp: 'serving', can_take_dhcp: false });
    expect(list.instances.find((row) => row.is_controller)).toMatchObject({
      dhcp: null,
      can_take_dhcp: true,
    });
    expect((await admin().get('/api/features')).body.instance.serves_dhcp).toBe(false);
  });

  it('keeps the controller from storing its own old leases while the member serves', async () => {
    // The controller's server still lists what it had: none of it counts now.
    backend.seedLeases([v4('10.9.0.199', mac('99'))]);
    await syncLeasesNow(controller);
    expect(stored().map((row) => row.ip_address)).toEqual(['10.9.0.110', 'fd00:9::110']);
  });

  it('does not let the member that serves DHCP take itself off the list', async () => {
    const response = await syncRequest({
      address: '127.0.0.1',
      port,
      fingerprint: identity.fingerprint,
      method: 'POST',
      path: '/api/sync/leave',
      credential: readCredential(a.db),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('dhcp_active');
    expect(controller.prepare('SELECT 1 FROM sync_instances WHERE id = ?').get(a.row)).toBeTruthy();
  });

  it('refuses to remove the member that serves DHCP', async () => {
    const response = await admin().delete(`/api/instances/${a.row}`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('dhcp_active');
    expect(response.body.error).toMatch(/Move DHCP to another instance first/);
    expect(controller.prepare('SELECT 1 FROM sync_instances WHERE id = ?').get(a.row)).toBeTruthy();
    expect(audits('instance_remove_refused')).toHaveLength(1);
  });
});

describe('a lease report', () => {
  const set = [
    v4('10.9.0.120', mac('03'), 'laptop'),
    v6('fd00:9::120', duid('03'), 'laptop6'),
    // Each reservation's own client.
    v4('10.9.0.50', mac('02'), 'printer'),
    v6('fd00:9::50', duid('02'), 'printer6'),
    // Another client on a reserved address: refused, and to be released.
    v4('10.9.0.60', mac('0b'), 'squatter'),
    v6('fd00:9::60', duid('0b'), 'squatter6'),
    // Outside every pool: refused.
    v4('10.9.0.240', mac('0c'), 'stray'),
    v6('fd00:9::9999', duid('0c'), 'stray6'),
  ];
  const later = [
    v6('fd00:9::120', duid('03'), 'renamed6'),
    v4('10.9.0.121', mac('04'), 'tablet'),
    v4('10.9.0.50', mac('02'), 'printer'),
    v6('fd00:9::60', duid('0b'), 'squatter6'),
  ];
  // Everything but row ids' neighbors in time: the columns that say what a
  // lease, an address and a DHCP-made record are.
  function picture(db) {
    const columns = (table) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name)
        .filter((name) => name === 'expires_at' || !(name.endsWith('_at') || name === 'last_seen'))
        .join(', ');
    return {
      // A lease that left the set is kept, expired as of that moment: the two
      // sides did that a moment apart.
      leases: db
        .prepare(`SELECT ${columns('dhcp_leases')} FROM dhcp_leases ORDER BY ip_address`)
        .all()
        .map((row) => (isLeaseActive(row.expires_at) ? row : { ...row, expires_at: 'expired' })),
      addresses: db
        .prepare(`SELECT ${columns('ip_addresses')} FROM ip_addresses ORDER BY address_sort_key`)
        .all(),
      records: db
        .prepare(
          `SELECT ${columns('dns_records')} FROM dns_records
           WHERE source IN ('dhcp', 'reservation') ORDER BY type, name, value`,
        )
        .all(),
    };
  }
  const who = (leases) => leases.map((lease) => `${lease.ip} ${lease.duid || lease.mac}`).sort();

  it('leaves the controller exactly as its own lease sync would have (differential)', async () => {
    // The member's two leases from the move are gone from its server.
    await reportLeases(a.db, []);
    expect(stored()).toEqual([]);
    // The controller as it is now, copied, and the copy made a controller
    // that serves DHCP itself: its own sink keeps its own leases.
    const twinPath = path.join(fs.mkdtempSync(path.join(controllerDir, 'twin-')), 'cidrella.db');
    controller.prepare('VACUUM INTO ?').run(twinPath);
    twin = new Database(twinPath);
    twin.prepare("DELETE FROM settings WHERE key IN ('dhcp_active_instance', 'dhcp_term')").run();
    expect(holdsDhcp(twin)).toBe(true);
    expect(holdsDhcp(controller)).toBe(false);

    for (const leases of [set, later]) {
      const local = await localSink.leases(twin, leases);
      const remote = await memberSink.leases(a.db, leases);
      expect(remote.synced).toBe(local.synced);
      expect(remote.rejected).toBe(local.rejected);
      expect(who(remote.blocking)).toEqual(who(local.blocking));
      expect(picture(controller)).toEqual(picture(twin));
    }

    // And the picture is not an empty one.
    const end = picture(controller);
    expect(stored().map((lease) => lease.ip_address)).toEqual([
      '10.9.0.121',
      '10.9.0.50',
      'fd00:9::120',
    ]);
    expect(end.addresses.find((row) => row.ip_address === '10.9.0.50').allocation_state).toBe(
      'static_dhcp',
    );
    expect(end.addresses.find((row) => row.ip_address === 'fd00:9::120').allocation_state).toBe(
      'dynamic_dhcp',
    );
    expect(end.records.map((record) => `${record.type} ${record.name}`)).toEqual(
      expect.arrayContaining(['A tablet', 'A printer', 'AAAA renamed6']),
    );
  });

  it('counts what was kept and names the leases to release, both families', async () => {
    const result = await reportLeases(a.db, set);
    expect(result).toMatchObject({ synced: 4, rejected: 4, release: [] });
    expect(who(result.blocking)).toEqual([`10.9.0.60 ${mac('0b')}`, `fd00:9::60 ${duid('0b')}`]);
  });

  it('is taken only from the active instance, at the current term', async () => {
    const before = stored();
    const other = await post(b, { term: 1, leases: [] });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('not_dhcp_active');
    for (const term of [0, 2]) {
      const stale = await post(a, { term, leases: [] });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('not_dhcp_active');
    }
    // A final report with no handover pending is nobody's to send.
    const final = await post(a, { term: 0, final: true, leases: [] });
    expect(final.status).toBe(409);
    expect(stored()).toEqual(before);
    // A member that is not active does not even ask.
    const asked = leasePosts;
    expect(await reportLeases(b.db, [v4('10.9.0.130', mac('05'))])).toEqual({
      synced: 0,
      rejected: 0,
      blocking: [],
    });
    expect(leasePosts).toBe(asked);
  });

  it('refuses a body that is not a report, and one without a credential', async () => {
    const before = stored();
    expect((await post(a, null, { raw: Buffer.from('{"term":1,"leases":[]}') })).status).toBe(400);
    expect(
      (await post(a, null, { raw: '{"term":1,"leases":[]}', type: 'application/json' })).status,
    ).toBe(400);
    expect((await post(a, { leases: [] })).status).toBe(400);
    expect((await post(a, { term: 1, leases: 'all of them' })).status).toBe(400);
    const anonymous = await syncRequest({
      address: '127.0.0.1',
      port,
      fingerprint: identity.fingerprint,
      method: 'POST',
      path: '/api/sync/leases',
      credential: 'cs1_notacredentialthecontrollerissued',
      headers: { 'content-type': LEASE_REPORT_TYPE },
      body: packReport({ term: 1, leases: [] }),
    });
    expect(anonymous.status).toBe(401);
    expect(stored()).toEqual(before);
  });

  it('keeps the good leases among malformed ones', async () => {
    const { status, body } = await post(a, {
      term: 1,
      leases: [
        v4('10.9.0.140', mac('06'), 'good'),
        { ...v4('10.9.0.141', mac('07')), ip: '10.9.0.999' },
        v6('fd00:9::140', duid('06'), 'good6'),
        { ...v6('fd00:9::141', duid('07')), duid: { $gt: '' } },
        'a lease',
        {
          ...v4('10.9.0.142', mac('08')),
          subnetId: 1,
          lifecycleValidated: true,
          extra: 'x'.repeat(50),
        },
      ],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ synced: 3, rejected: 0, invalid: 3 });
    expect(stored().map((row) => row.ip_address)).toEqual([
      '10.9.0.140',
      '10.9.0.142',
      'fd00:9::140',
    ]);
  });

  it('carries 5000 leases, both families, past the 100 KB JSON limit', async () => {
    const leases = [];
    for (let i = 0; i < 2500; i++) {
      const hex = i.toString(16).padStart(4, '0');
      const tail = `${hex.slice(0, 2)}:${hex.slice(2)}`;
      leases.push(v4(`10.50.${1 + (i >> 8)}.${i & 255}`, `aa:bb:cc:01:${tail}`, `host-${i}`));
      leases.push(v6(`fd00:50::${(0x1000 + i).toString(16)}`, `00:01:00:01:00:01:${tail}`));
    }
    expect(JSON.stringify({ term: 1, leases }).length).toBeGreaterThan(500 * 1024);
    const result = await reportLeases(a.db, leases);
    expect(result).toMatchObject({ synced: 5000, rejected: 0, blocking: [] });
    expect(stored()).toHaveLength(5000);
    expect(
      controller
        .prepare(
          `SELECT dhcp_version AS v, count(*) AS n FROM dhcp_leases
           WHERE ${activeLeaseSql()} GROUP BY 1 ORDER BY 1`,
        )
        .all(),
    ).toEqual([
      { v: 4, n: 2500 },
      { v: 6, n: 2500 },
    ]);
    await reportLeases(a.db, []);
  }, 120_000);

  it('answers with the releases the controller decided on, until a report no longer holds them', async () => {
    const held = [v4('10.9.0.150', mac('15')), v6('fd00:9::150', duid('15'))];
    const keep = v4('10.9.0.151', mac('16'));
    await reportLeases(a.db, [...held, keep]);

    // The controller's server is not the one holding them: they are queued.
    const controllerRelease = vi.fn(() => ({ released: true }));
    backend.dhcp.releaseLease = controllerRelease;
    for (const lease of held) {
      expect(await releaseLeaseAnywhere(controller, lease)).toEqual({
        released: false,
        skipped: 'queued',
      });
    }
    expect(controllerRelease).not.toHaveBeenCalled();
    expect(queuedReleases()).toBe(2);

    // The member's own lease sync is told, and releases them at its server.
    const undo = setFactsSink(memberSink);
    const memberRelease = vi.fn(() => ({ released: true }));
    backend.dhcp.releaseLease = memberRelease;
    backend.seedLeases([...held, keep]);
    const first = await syncLeasesNow(a.db);
    expect(first.release.map((lease) => lease.ip).sort()).toEqual(['10.9.0.150', 'fd00:9::150']);
    expect(memberRelease.mock.calls.map(([lease]) => lease.ip).sort()).toEqual([
      '10.9.0.150',
      'fd00:9::150',
    ]);
    // Its next report no longer holds them: done.
    backend.seedLeases([keep]);
    const second = await syncLeasesNow(a.db);
    undo();
    expect(second.release).toEqual([]);
    expect(queuedReleases()).toBe(0);
    backend.dhcp.releaseLease = (lease) =>
      lease?.ip ? { released: true } : { released: false, skipped: 'invalid-identity' };
  });

  it('keeps serving and tries again within 30 seconds while the controller is away', async () => {
    const pinned = JSON.parse(
      a.db.prepare("SELECT value FROM sync_state WHERE key = 'controller'").get().value,
    );
    writeSyncState(
      a.db,
      'controller',
      JSON.stringify({ ...pinned, port: await freePort({ tcp: true }) }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retry = vi.fn();
    const forget = onLeaseReportRetry(retry);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const leases = [v4('10.9.0.160', mac('17'))];
    const nothing = { synced: 0, rejected: 0, blocking: [] };
    expect(await reportLeases(a.db, leases)).toEqual(nothing);
    expect(await reportLeases(a.db, leases)).toEqual(nothing);
    expect(servesDhcpHere(a.db)).toBe(true);
    // One line for the outage, not one per attempt.
    expect(
      warn.mock.calls.filter(([line]) => /did not reach the controller/.test(line)),
    ).toHaveLength(1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_000);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(retry).toHaveBeenCalledTimes(1);

    // The controller is back: the same report goes through.
    vi.useRealTimers();
    writeSyncState(a.db, 'controller', JSON.stringify(pinned));
    expect(await reportLeases(a.db, leases)).toMatchObject({ synced: 1 });
    forget();
  });
});

describe('moving DHCP from a member', () => {
  it('to the controller: the member stops, sends its final leases, and the controller starts with them', async () => {
    await syncOnce(a.db);
    const response = await move(controllerRow);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      active_instance_id: ownInstanceId(controller),
      term: 2,
      handover: { from_instance_id: a.instanceId, from_name: 'member-a' },
    });
    expect(Date.parse(response.body.handover.since)).toBeGreaterThan(Date.now() - 60_000);

    // Nobody serves until the member has handed over.
    expect(servesDhcpHere(controller)).toBe(false);
    const list = (await admin().get('/api/instances')).body;
    const rows = Object.fromEntries(list.instances.map((row) => [row.name, row]));
    expect(rows['member-a']).toMatchObject({ dhcp: 'handing_over', can_take_dhcp: false });
    expect(rows['member-b']).toMatchObject({ dhcp: null, can_take_dhcp: false });
    expect(list.instances.find((row) => row.is_controller).dhcp).toBe('starting');
    expect(list.dhcp.handover.from_name).toBe('member-a');

    // No second move while one is pending.
    const again = await move(b.row);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('handover_pending');

    // The member still serves on what it last heard, and its report at the
    // old term is refused: it stops reporting without asking again.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(servesDhcpHere(a.db)).toBe(true);
    const asked = leasePosts;
    await reportLeases(a.db, [v4('10.9.0.170', mac('18'))]);
    await reportLeases(a.db, [v4('10.9.0.170', mac('18'))]);
    expect(leasePosts).toBe(asked + 1);

    // It hears, stops, and sends what its server held at the end.
    backend.seedLeases([v4('10.9.0.171', mac('19'), 'last'), v6('fd00:9::171', duid('19'))]);
    backend.dhcp.importLeases.mockClear();
    await catchUp(a);
    expect(servesDhcpHere(a.db)).toBe(false);
    expect(stored().map((row) => row.ip_address)).toEqual(['10.9.0.171', 'fd00:9::171']);
    expect(audits('dhcp_handover_completed')).toHaveLength(1);

    // The handover is over: the controller loaded those leases and serves.
    expect(dhcpState(controller)).toMatchObject({ handoverFrom: null, term: 2, readyTerm: 2 });
    expect(backend.dhcp.importLeases).toHaveBeenCalledTimes(1);
    expect(backend.dhcp.importLeases.mock.calls[0][0].map((lease) => lease.ip).sort()).toEqual([
      '10.9.0.171',
      'fd00:9::171',
    ]);
    expect(servesDhcpHere(controller)).toBe(true);
    // And its own lease sync stores leases again.
    backend.seedLeases([v4('10.9.0.172', mac('1a'))]);
    await syncLeasesNow(controller);
    expect(stored().map((row) => row.ip_address)).toEqual(['10.9.0.172']);
  });

  it('to another member: the new one waits for the old one, then starts with its leases', async () => {
    // Back to member A first.
    await syncOnce(a.db);
    expect((await move(a.row)).body).toMatchObject({ term: 3, handover: null });
    await catchUp(a);
    expect(servesDhcpHere(a.db)).toBe(true);

    await syncOnce(b.db);
    const response = await move(b.row);
    expect(response.body).toMatchObject({
      active_instance_id: b.instanceId,
      term: 4,
      handover: { from_name: 'member-a' },
    });

    backend.dhcp.importLeases.mockClear();
    await catchUp(b);
    expect(servesDhcpHere(b.db)).toBe(false);
    expect(backend.dhcp.importLeases).not.toHaveBeenCalled();

    backend.seedLeases([v4('10.9.0.180', mac('1b')), v6('fd00:9::180', duid('1b'))]);
    await catchUp(a);
    expect(dhcpState(controller).handoverFrom).toBeNull();
    expect(servesDhcpHere(controller)).toBe(false);

    await catchUp(b);
    expect(backend.dhcp.importLeases.mock.calls[0][0].map((lease) => lease.ip).sort()).toEqual([
      '10.9.0.180',
      'fd00:9::180',
    ]);
    expect(servesDhcpHere(b.db)).toBe(true);
    await syncOnce(a.db);
    expect(servesDhcpHere(a.db)).toBe(false);
    expect(await reportLeases(b.db, [v4('10.9.0.181', mac('1c'))])).toMatchObject({ synced: 1 });
  });

  it('started by force when the old member is dead, with the leases the controller last heard', async () => {
    const none = await admin().post('/api/instances/dhcp/force').send({ confirm: true });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('no_handover');

    await syncOnce(a.db);
    expect((await move(a.row)).body).toMatchObject({
      active_instance_id: a.instanceId,
      term: 5,
      handover: { from_name: 'member-b' },
    });
    // Member B never hears of it. Without the confirmation nothing happens.
    expect((await admin().post('/api/instances/dhcp/force').send({})).status).toBe(400);
    expect((await admin().post('/api/instances/dhcp/force').send({ confirm: 'yes' })).status).toBe(
      400,
    );
    expect(dhcpState(controller).handoverFrom).toBe(b.instanceId);

    const forced = await admin().post('/api/instances/dhcp/force').send({ confirm: true });
    expect(forced.status).toBe(200);
    expect(forced.body).toEqual({ active_instance_id: a.instanceId, term: 5, handover: null });
    expect(JSON.parse(audits('dhcp_handover_forced')[0].details)).toMatchObject({
      from: 'member-b',
      to: 'member-a',
      term: 5,
    });

    backend.dhcp.importLeases.mockClear();
    await catchUp(a);
    expect(backend.dhcp.importLeases.mock.calls[0][0].map((lease) => lease.ip)).toEqual([
      '10.9.0.181',
    ]);
    expect(servesDhcpHere(a.db)).toBe(true);

    // The old member comes back: it stops, and its late leases are not kept.
    backend.seedLeases([v4('10.9.0.190', mac('1d'))]);
    await catchUp(b);
    expect(servesDhcpHere(b.db)).toBe(false);
    expect(dhcpState(b.db).readyTerm).toBeNull();
    expect(stored().map((row) => row.ip_address)).toEqual(['10.9.0.181']);
  });
});

describe('a step cut short', () => {
  it('a member that died before its server had the leases loads them when it comes back', async () => {
    // As the process finds itself after a restart: the settings name it, at a
    // term its server never loaded.
    markDhcpReady(a.db, null);
    expect(servesDhcpHere(a.db)).toBe(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend.dhcp.importLeases.mockClear();
    backend.dhcp.importLeases.mockRejectedValueOnce(new Error('the DHCP server is not up yet'));
    await followDhcp(a.db);
    expect(servesDhcpHere(a.db)).toBe(false);
    await followDhcp(a.db);
    expect(backend.dhcp.importLeases).toHaveBeenCalledTimes(2);
    expect(servesDhcpHere(a.db)).toBe(true);
  });

  it('a controller that died after writing a move away stops serving at boot', async () => {
    // Bring DHCP home, then write a move to member B as the transaction
    // would, and nothing after it.
    await syncOnce(a.db);
    await move(controllerRow);
    backend.seedLeases([]);
    await catchUp(a);
    expect(servesDhcpHere(controller)).toBe(true);
    controller.transaction(() => {
      upsertSetting(controller, 'dhcp_term', 7);
      upsertSetting(controller, 'dhcp_active_instance', b.instanceId);
    })();
    // Boot: the rule already says no, and following clears what it held.
    await followDhcp(controller);
    expect(servesDhcpHere(controller)).toBe(false);
    expect(dhcpState(controller).readyTerm).toBeNull();
    await catchUp(b);
    expect(servesDhcpHere(b.db)).toBe(true);
  });

  it('a controller that died before a handover finished serves once the final leases arrive', async () => {
    await syncOnce(b.db);
    expect((await move(controllerRow)).body.handover.from_name).toBe('member-b');
    // The controller restarts here: following at boot starts nothing early.
    await followDhcp(controller);
    expect(servesDhcpHere(controller)).toBe(false);
    backend.seedLeases([v6('fd00:9::1a0', duid('1e'))]);
    await catchUp(b);
    expect(servesDhcpHere(controller)).toBe(true);
    expect(stored().map((row) => row.ip_address)).toEqual(['fd00:9::1a0']);
  });
  // Last: it takes a member off the list.
  it('ends a handover when the member that owed its leases is removed', async () => {
    const state = dhcpState(controller);
    const owing = state.active === a.instanceId ? b : a;
    upsertSetting(controller, 'dhcp_handover_from', owing.instanceId);
    upsertSetting(controller, 'dhcp_handover_since', new Date().toISOString());
    expect(dhcpState(controller).handoverFrom).toBe(owing.instanceId);

    expect((await admin().delete(`/api/instances/${owing.row}`)).status).toBeLessThan(300);

    expect(dhcpState(controller).handoverFrom).toBeNull();
  });
});
