/**
 * What a member observes reaches its controller: the clients its DNS proxy
 * hears and the DHCP fingerprints it reads go through the remote sink, wait
 * in sync_outbox, travel with sendOutbox over the pinned HTTPS connection,
 * and are recorded on the controller as of the time the member observed
 * them. Two databases, one process, as in sync-pairing.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { freePort } = await import('../helpers/free-port.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { joinController, sendOutbox } = await import('../../src/sync/member.js');
const { createJoinToken } = await import('../../src/models/sync-instance.js');
const { memberSink } = await import('../../src/sync/facts.js');
const { flushSeen, stopRemoteSink, FINGERPRINT_KIND, SEEN_KIND } =
  await import('../../src/sync/remote-sink.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { sqlTime } = await import('../../src/utils/sql-time.js');
const { setManual } = await import('../../src/models/device-fingerprint.js');

let controller;
let controllerDir;
let server;
let box;
const tmpDirs = [];

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  enableIpv6(controller);
  const identity = ensureSyncIdentity(controllerDir);
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const subnet = controller.prepare(
    `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status) VALUES (?, ?, ?, ?, ?, ?, 'allocated')`,
  );
  subnet.run('10.77.0.0/24', 'four', '10.77.0.0', '10.77.0.255', 24, 256);
  subnet.run('fd00:77::/64', 'six', 'fd00:77::', null, 64, 0);
  invalidateSubnetCache();

  const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  ensureSyncIdentity(tmpDir);
  box = { db, dir: tmpDir };
  const { token } = createJoinToken(controller, { fingerprint: identity.fingerprint });
  await joinController(box.db, { address: '127.0.0.1', port, token }, { restart: () => {} });
});
afterAll(async () => {
  stopRemoteSink();
  await new Promise((resolve) => server.close(resolve));
  cleanupTestDb(controllerDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  stopRemoteSink();
  box.db.prepare('DELETE FROM sync_outbox').run();
});

const address = (ip) =>
  controller.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get(ip);
const fingerprintOf = (mac) =>
  controller.prepare('SELECT * FROM device_fingerprints WHERE mac_address = ?').get(mac);
const queue = (kind, payload) =>
  box.db
    .prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)')
    .run(kind, typeof payload === 'string' ? payload : JSON.stringify(payload));
const waiting = () => box.db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n;
const ago = (seconds) => Date.now() - seconds * 1000;
/** A row the controller already has, last seen `seenAgo` seconds ago. */
function known(ip, { online, seenAgo, offlineAgo = null }) {
  const family = ip.includes(':') ? 6 : 4;
  const subnetId = controller
    .prepare('SELECT id FROM subnets WHERE cidr = ?')
    .get(family === 4 ? '10.77.0.0/24' : 'fd00:77::/64').id;
  controller
    .prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, address_family, address_sort_key,
         is_online, last_seen_at, first_seen_at, offline_since_at, allocation_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
    )
    .run(
      subnetId,
      ip,
      family,
      ip,
      online ? 1 : 0,
      sqlTime(ago(seenAgo)),
      sqlTime(ago(seenAgo)),
      offlineAgo === null ? null : sqlTime(ago(offlineAgo)),
    );
}

describe('what a member observes', () => {
  it('reaches the controller with the time the member observed it, both families', async () => {
    memberSink.clientSeen(box.db, '10.77.0.10', { createRogue: true, source: 'passive' });
    memberSink.clientSeen(box.db, 'fd00:77::10', { createRogue: true, source: 'passive' });
    memberSink.fingerprint(box.db, {
      mac_address: 'AA:BB:CC:77:00:10',
      dhcp_fingerprint: '1,3,6,15',
      vendor_class: 'MSFT 5.0',
      dhcp_hostname: 'desk',
      device_type: 'Computer',
      os_family: 'Windows',
      confidence: 80,
      source: 'dhcp',
      raw: '{"opt55":"1,3,6,15"}',
    });
    flushSeen(box.db);
    // The member saw all of it two minutes before it could send, and had the
    // IPv4 client's MAC.
    const seenAt = ago(120);
    for (const row of box.db.prepare('SELECT id, kind, payload FROM sync_outbox').all()) {
      const payload = JSON.parse(row.payload);
      if (row.kind === SEEN_KIND) {
        payload.seen.forEach((entry) => (entry.at = seenAt));
        payload.seen.find((entry) => entry.ip === '10.77.0.10').mac = 'AA:BB:CC:77:00:10';
      } else payload.at = seenAt;
      box.db
        .prepare('UPDATE sync_outbox SET payload = ? WHERE id = ?')
        .run(JSON.stringify(payload), row.id);
    }
    // The member itself recorded nothing in the data of record.
    expect(box.db.prepare('SELECT count(*) AS n FROM ip_addresses').get().n).toBe(0);

    expect(await sendOutbox(box.db)).toBe(2);

    expect(waiting()).toBe(0);
    expect(address('10.77.0.10')).toMatchObject({
      is_online: 1,
      is_rogue: 1,
      last_seen_at: sqlTime(seenAt),
      first_seen_at: sqlTime(seenAt),
      last_seen_mac: 'aa:bb:cc:77:00:10',
      detection_source: 'passive',
      allocation_state: 'unassigned',
    });
    // No scope on the IPv6 network: liveness only, never a rogue.
    expect(address('fd00:77::10')).toMatchObject({
      is_online: 1,
      is_rogue: 0,
      last_seen_at: sqlTime(seenAt),
      first_seen_at: sqlTime(seenAt),
    });
    expect(fingerprintOf('aa:bb:cc:77:00:10')).toMatchObject({
      dhcp_fingerprint: '1,3,6,15',
      device_type: 'Computer',
      os_family: 'Windows',
      confidence: 80,
      source: 'dhcp',
      first_seen_at: sqlTime(seenAt),
      last_seen_at: sqlTime(seenAt),
    });
  });

  it('sends the clients heard since the last flush with the round', async () => {
    memberSink.clientSeen(box.db, '10.77.0.11', { createRogue: true });
    memberSink.clientSeen(box.db, 'fd00:77::11', { createRogue: true });
    expect(waiting()).toBe(0);
    expect(await sendOutbox(box.db)).toBe(1);
    expect(address('10.77.0.11').is_online).toBe(1);
    expect(address('fd00:77::11').is_online).toBe(1);
  });
});

describe('a sighting that arrives late', () => {
  it('never moves last_seen_at backwards, either family', async () => {
    known('10.77.0.20', { online: true, seenAgo: 60 });
    known('fd00:77::20', { online: true, seenAgo: 60 });
    const before = [address('10.77.0.20'), address('fd00:77::20')];
    queue(SEEN_KIND, {
      seen: [
        // An hour old, and three minutes old: the controller saw both since.
        { ip: '10.77.0.20', at: ago(3600), rogue: 1 },
        { ip: 'fd00:77::20', at: ago(180), rogue: 1, mac: 'aa:bb:cc:77:00:20' },
      ],
    });
    await sendOutbox(box.db);
    expect([address('10.77.0.20'), address('fd00:77::20')]).toEqual(before);
  });

  it('older than the stale window is history: last seen moves, online does not', async () => {
    known('10.77.0.21', { online: false, seenAgo: 7200, offlineAgo: 7000 });
    known('fd00:77::21', { online: false, seenAgo: 7200, offlineAgo: 7000 });
    const at = ago(3600);
    queue(SEEN_KIND, {
      seen: [
        { ip: '10.77.0.21', at, rogue: 1 },
        { ip: 'fd00:77::21', at, rogue: 1 },
        // Unknown addresses, an hour ago: no row, and no rogue.
        { ip: '10.77.0.22', at, rogue: 1 },
        { ip: 'fd00:77::22', at, rogue: 1 },
      ],
    });
    await sendOutbox(box.db);
    for (const ip of ['10.77.0.21', 'fd00:77::21']) {
      expect(address(ip)).toMatchObject({ is_online: 0, last_seen_at: sqlTime(at) });
      expect(address(ip).offline_since_at).not.toBeNull();
    }
    expect(address('10.77.0.22')).toBeUndefined();
    expect(address('fd00:77::22')).toBeUndefined();
  });

  it('does not bring back an address decided offline after it was made', async () => {
    known('10.77.0.23', { online: false, seenAgo: 1200, offlineAgo: 60 });
    known('fd00:77::23', { online: false, seenAgo: 1200, offlineAgo: 60 });
    const at = ago(120);
    queue(SEEN_KIND, {
      seen: [
        { ip: '10.77.0.23', at },
        { ip: 'fd00:77::23', at, rogue: 1 },
      ],
    });
    await sendOutbox(box.db);
    for (const ip of ['10.77.0.23', 'fd00:77::23']) {
      expect(address(ip)).toMatchObject({ is_online: 0, last_seen_at: sqlTime(at) });
    }

    // One made after that decision does.
    const later = ago(30);
    queue(SEEN_KIND, {
      seen: [
        { ip: '10.77.0.23', at: later },
        { ip: 'fd00:77::23', at: later, rogue: 1 },
      ],
    });
    await sendOutbox(box.db);
    for (const ip of ['10.77.0.23', 'fd00:77::23']) {
      expect(address(ip)).toMatchObject({
        is_online: 1,
        last_seen_at: sqlTime(later),
        offline_since_at: null,
      });
    }
  });

  it('takes a time in the future as now', async () => {
    const started = sqlTime(Date.now());
    queue(SEEN_KIND, {
      seen: [
        { ip: '10.77.0.24', at: Date.now() + 86_400_000, rogue: 1 },
        { ip: 'fd00:77::24', at: Date.now() + 86_400_000, rogue: 1 },
      ],
    });
    queue(FINGERPRINT_KIND, { mac_address: 'aa:bb:cc:77:00:24', at: Date.now() + 86_400_000 });
    await sendOutbox(box.db);
    const ended = sqlTime(Date.now());
    for (const row of [
      address('10.77.0.24'),
      address('fd00:77::24'),
      fingerprintOf('aa:bb:cc:77:00:24'),
    ]) {
      expect(row.last_seen_at >= started && row.last_seen_at <= ended).toBe(true);
    }
  });

  it('reads a member’s times by the member’s clock, when that clock is wrong', async () => {
    // The member thinks it is an hour ago: a client it hears now is online now.
    const hourAgo = Date.now() - 3_600_000;
    const realNow = Date.now;
    queue(SEEN_KIND, {
      seen: [
        { ip: '10.77.0.61', at: hourAgo, rogue: 1 },
        { ip: 'fd00:77::61', at: hourAgo, rogue: 1 },
      ],
    });
    const started = sqlTime(realNow());
    // Only the member's send reads the shifted clock: the controller answers after.
    Date.now = () => realNow() - 3_600_000;
    const sending = sendOutbox(box.db);
    Date.now = realNow;
    await sending;
    for (const row of [address('10.77.0.61'), address('fd00:77::61')]) {
      expect(row.is_online).toBe(1);
      expect(row.last_seen_at >= started).toBe(true);
    }
  });

  it('drops a fingerprint older than the capture already recorded', async () => {
    queue(FINGERPRINT_KIND, {
      mac_address: 'aa:bb:cc:77:00:25',
      vendor_class: 'new',
      device_type: 'Printer',
      confidence: 60,
      at: ago(60),
    });
    queue(FINGERPRINT_KIND, {
      mac_address: 'aa:bb:cc:77:00:25',
      vendor_class: 'old',
      device_type: 'Computer',
      confidence: 90,
      at: ago(3600),
    });
    await sendOutbox(box.db);
    expect(fingerprintOf('aa:bb:cc:77:00:25')).toMatchObject({
      vendor_class: 'new',
      device_type: 'Printer',
      confidence: 60,
    });
  });
});

describe('a row a member should not have sent', () => {
  it('is taken and dropped, and the good ones around it are recorded', async () => {
    setManual(controller, 'aa:bb:cc:77:00:31', { device_type: 'Router', os_family: 'Junos' });
    const at = ago(10);
    queue(SEEN_KIND, 'not json');
    queue(SEEN_KIND, { seen: 'everything' });
    queue('mystery', { seen: [{ ip: '10.77.0.39', at, rogue: 1 }] });
    queue(SEEN_KIND, {
      seen: [
        null,
        'a string',
        { ip: 'not-an-address', at, rogue: 1 },
        { ip: '10.77.0.30', at: 'yesterday', rogue: 1 },
        { ip: 'fd00:77::30%eth0', at, rogue: 1 },
        { ip: '127.0.0.1', at, rogue: 1 },
        { ip: '192.0.2.77', at, rogue: 1 },
        // Good ones, with fields that mean nothing here or are not what they say.
        { ip: '10.77.0.31', at, rogue: 1, mac: 'not-a-mac', source: 'manual', is_rogue: 0 },
        { ip: 'FD00:77:0:0::31', at, rogue: true, allocation_state: 'reserved' },
      ],
    });
    queue(FINGERPRINT_KIND, { mac_address: 'nonsense', at });
    queue(FINGERPRINT_KIND, { mac_address: 'aa:bb:cc:77:00:30' });
    queue(FINGERPRINT_KIND, {
      mac_address: 'aa:bb:cc:77:00:31',
      device_type: 'Toaster',
      confidence: 100,
      source: 'manual',
      at,
    });
    queue(FINGERPRINT_KIND, {
      mac_address: 'aa:bb:cc:77:00:32',
      device_type: 'x'.repeat(500),
      os_family: 'Linux',
      confidence: 1e9,
      source: 'manual',
      raw: { not: 'a string' },
      at,
    });
    queue(SEEN_KIND, { seen: [{ ip: '10.77.0.32', at }] });

    expect(await sendOutbox(box.db)).toBe(9);
    expect(waiting()).toBe(0);

    for (const ip of ['10.77.0.30', '10.77.0.39', 'fd00:77::30', '127.0.0.1', '192.0.2.77']) {
      expect(address(ip)).toBeUndefined();
    }
    expect(address('10.77.0.31')).toMatchObject({
      is_online: 1,
      is_rogue: 1,
      last_seen_mac: null,
      detection_source: 'passive',
      allocation_state: 'unassigned',
    });
    // `rogue` must be 1 to count, and the address is stored in its one spelling.
    expect(address('fd00:77::31')).toBeUndefined();
    // No rogue flag and no row: a sighting alone does not make one.
    expect(address('10.77.0.32')).toBeUndefined();

    expect(fingerprintOf('nonsense')).toBeUndefined();
    expect(fingerprintOf('aa:bb:cc:77:00:30')).toBeUndefined();
    // An operator's override stays, whatever the member says its source is.
    expect(fingerprintOf('aa:bb:cc:77:00:31')).toMatchObject({
      device_type: 'Router',
      os_family: 'Junos',
      source: 'manual',
    });
    expect(fingerprintOf('aa:bb:cc:77:00:32')).toMatchObject({
      device_type: null,
      os_family: 'Linux',
      confidence: 100,
      source: 'dhcp',
      raw: null,
    });
  });

  it('reads no more observations from one row than a member’s flush writes', async () => {
    const at = ago(10);
    const seen = [];
    for (let i = 0; i < 600; i++) {
      seen.push({ ip: `10.77.${1 + (i >> 8)}.${i & 255}`, at, rogue: 1 });
    }
    // These are outside 10.77.0.0/24, so make the network they are in.
    controller
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
           total_addresses, status) VALUES ('10.77.0.0/16', 'wide', '10.77.0.0', '10.77.255.255', 16, 65536, 'allocated')`,
      )
      .run();
    controller.prepare("DELETE FROM subnets WHERE cidr = '10.77.0.0/24'").run();
    invalidateSubnetCache();
    queue(SEEN_KIND, { seen });
    await sendOutbox(box.db);
    expect(
      controller
        .prepare(
          "SELECT count(*) AS n FROM ip_addresses WHERE ip_address LIKE '10.77.1.%' OR ip_address LIKE '10.77.2.%'",
        )
        .get().n,
    ).toBe(500);
  });
  it('rations the new addresses one member may name in an hour, and still records known ones', async () => {
    const { NEW_ROWS_PER_HOUR, resetNewRowBudgets } =
      await import('../../src/sync/member-facts.js');
    resetNewRowBudgets();
    const rows = () =>
      controller
        .prepare("SELECT count(*) AS n FROM ip_addresses WHERE ip_address LIKE 'fd00:77::a:%'")
        .get().n;
    const at = Date.now();
    const total = NEW_ROWS_PER_HOUR + 500;
    for (let start = 0; start < total; start += 500) {
      queue(SEEN_KIND, {
        seen: Array.from({ length: 500 }, (_, i) => ({
          ip: `fd00:77::a:${(start + i).toString(16)}`,
          at,
          rogue: 1,
        })),
      });
    }
    await sendOutbox(box.db);
    expect(rows()).toBeLessThanOrEqual(NEW_ROWS_PER_HOUR);

    // One it already holds is not a new row: its sighting still lands.
    expect(address('fd00:77::a:0')).toBeDefined();
    controller
      .prepare(
        "UPDATE ip_addresses SET last_seen_at = '2020-01-01 00:00:00' WHERE ip_address = 'fd00:77::a:0'",
      )
      .run();
    queue(SEEN_KIND, { seen: [{ ip: 'fd00:77::a:0', at: Date.now() }] });
    await sendOutbox(box.db);
    expect(address('fd00:77::a:0').last_seen_at > '2020-01-02').toBe(true);
    resetNewRowBudgets();
  });
});
