/**
 * Analytics from every instance: a member sends its metrics and DNS query
 * rows up to its controller over a real pinned HTTPS connection, and the
 * controller's analytics read them by instance.
 *
 * Two SQLite databases in one process, as in sync-pairing.test.js. There is
 * one analytics (DuckDB) database per process, so here it stands for both
 * ends: the rows logged below are the member's own (no instance id), and what
 * the controller stores of them carries the member's id beside them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import https from 'https';
import request from 'supertest';

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { databaseThrough, LATEST_MIGRATION } = await import('../helpers/migrations.js');
const { listenLocal } = await import('../helpers/free-port.js');
const { createMultiRouterApp } = await import('../helpers/test-app.js');
const { default: syncRoutes } = await import('../../src/routes/sync.js');
const { default: collectedRoutes } = await import('../../src/routes/sync-collected.js');
const { default: metricsRoutes } = await import('../../src/routes/metrics.js');
const { default: analyticsRoutes } = await import('../../src/routes/analytics.js');
const { ensureSyncIdentity } = await import('../../src/sync/identity.js');
const { readSyncState, writeSyncState } = await import('../../src/sync/log.js');
const { controllerOf } = await import('../../src/sync/mode.js');
const { joinController, readCredential } = await import('../../src/sync/member.js');
const { uploadCollectedOnce } = await import('../../src/sync/collected-upload.js');
const { MAX_BATCH_ROWS } = await import('../../src/sync/collected-streams.js');
const { createJoinToken, ownInstanceId } = await import('../../src/models/sync-instance.js');
const { syncRequest } = await import('../../src/utils/sync-client.js');
const { closeAnalyticsDb, flushQueries, initAnalyticsDb, logDnsQuery, queryRaw } =
  await import('../../src/db/duckdb.js');

let controller;
let controllerDir;
let identity;
let server;
let port;
let api;
let box;
let memberId;
const tmpDirs = [];

// The minute these rows are for, and the one before it.
const NOW = Math.floor(Date.now() / 60_000) * 60;
const BEFORE = NOW - 60;

beforeAll(async () => {
  ({ db: controller, tmpDir: controllerDir } = await setupTestDb());
  await initAnalyticsDb(controllerDir);
  identity = ensureSyncIdentity(controllerDir);
  const app = express();
  app.use(express.json());
  app.use('/api/sync/collected', collectedRoutes);
  app.use('/api/sync', syncRoutes);
  server = https.createServer(
    { key: fs.readFileSync(identity.keyPath), cert: fs.readFileSync(identity.certPath) },
    app,
  );
  port = await listenLocal(server);
  api = request(
    createMultiRouterApp([
      { prefix: '/api/metrics', router: metricsRoutes },
      { prefix: '/api/analytics', router: analyticsRoutes },
    ]),
  );
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeAnalyticsDb();
  cleanupTestDb(controllerDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const insertMetrics = (db, ts, dnsQueries, dhcp4) =>
  db
    .prepare(
      `INSERT INTO metrics (ts, dns_queries, dhcp_requests, dhcp4_client_msgs, blocklist_blocks)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(ts, dnsQueries, dhcp4, dhcp4);
const insertPerf = (db, ts, { queries, avg, p95, cpu }) =>
  db
    .prepare(
      `INSERT INTO metrics_proxy_perf
         (ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
          cache_hits, cache_misses, cpu_percent, rss_mb, heap_mb, servfail_dnssec, nxdomain)
       VALUES (?, ?, 100, ?, ?, ?, 3, 1, ?, 80.5, 40.25, 1, 2)`,
    )
    .run(ts, queries, avg, p95 * 2, p95, cpu);
const insertHits = (db, ts) => {
  db.prepare("INSERT INTO metrics_blocklist_hits (ts, category, count) VALUES (?, 'ads', 4)").run(
    ts,
  );
  db.prepare("INSERT INTO metrics_geoip_hits (ts, country, count) VALUES (?, 'ZZ', 2)").run(ts);
  db.prepare(
    `INSERT INTO metrics_forwarder
       (ts, provider, address, protocol, queries, answers, latency_p50_us, latency_p95_us)
     VALUES (?, 'dns.example', '2001:db8::53', 'dot', 10, 9, 900, 4000)`,
  ).run(ts);
};

const count = (db, table, where = '1=1') =>
  db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
const storedQueries = async (instanceId) =>
  (await queryRaw('SELECT count(*) AS n FROM dns_queries WHERE instance_id = ?', [instanceId]))[0]
    .n;

/** One batch, sent as the member would. */
const post = (stream, body, credential = readCredential(box.db)) =>
  syncRequest({
    ...controllerOf(box.db),
    method: 'POST',
    path: `/api/sync/collected/${stream}`,
    credential,
    body,
  }).then((res) => ({ status: res.status, body: JSON.parse(res.body.toString('utf8')) }));

describe('a single box', () => {
  beforeAll(() => {
    insertMetrics(controller, BEFORE, 5, 1);
    insertMetrics(controller, NOW, 7, 2);
    // A restart inside one minute leaves two rows for it.
    insertMetrics(controller, NOW, 1, 0);
    insertPerf(controller, BEFORE, { queries: 5, avg: 2000, p95: 9000, cpu: 3.5 });
    insertPerf(controller, NOW, { queries: 10, avg: 1000, p95: 5000, cpu: 4.5 });
    controller.prepare('INSERT INTO metrics_proxy_perf (ts, query_count) VALUES (?, 0)').run(NOW);
    insertHits(controller, NOW);
  });

  it('reads what it always read, row for row', async () => {
    const timeseries = await api.get('/api/metrics/timeseries?range=1h');
    expect(timeseries.body).toEqual(
      controller
        .prepare(
          `SELECT ts, dns_queries, dhcp_requests, dhcp_client_msgs, dhcp_server_msgs,
                  dhcp4_client_msgs, dhcp4_server_msgs, dhcp6_client_msgs, dhcp6_server_msgs,
                  blocklist_blocks, geoip_blocks
           FROM metrics WHERE ts >= ? ORDER BY ts`,
        )
        .all(NOW - 3600),
    );
    expect(timeseries.body).toHaveLength(3);

    const perf = await api.get('/api/metrics/proxy-perf?range=1h');
    expect(perf.body).toEqual(
      controller
        .prepare(
          `SELECT ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
                cache_hits, cache_misses, timeouts, pending_queries,
                cpu_percent, rss_mb, heap_mb, startup_ms,
                servfail_dnssec, servfail_upstream, servfail_timeout, servfail_refused,
                servfail_other, nxdomain
         FROM metrics_proxy_perf WHERE ts >= ? ORDER BY ts`,
        )
        .all(NOW - 3600),
    );
    // The same with every instance asked for by name.
    expect((await api.get('/api/metrics/proxy-perf?range=1h&instance=all')).body).toEqual(
      perf.body,
    );
    expect((await api.get('/api/metrics/blocklist-hits?range=1h')).body).toEqual([
      { category: 'ads', count: 4 },
    ]);
  });

  it('lists itself alone, and is the one instance it can be filtered by', async () => {
    const own = ownInstanceId(controller);
    const instances = (await api.get('/api/analytics/instances')).body;
    expect(instances).toEqual([expect.objectContaining({ instance_id: own, is_self: true })]);
    const mine = await api.get(`/api/metrics/timeseries?range=1h&instance=${own}`);
    expect(mine.body).toHaveLength(3);
  });
});

describe('a member sends its rows up', () => {
  beforeAll(async () => {
    const { db, tmpDir } = databaseThrough(LATEST_MIGRATION, { tmpDirs });
    ensureSyncIdentity(tmpDir);
    box = { db, dir: tmpDir };
    const { token } = createJoinToken(controller, { fingerprint: identity.fingerprint });
    await joinController(db, { address: '127.0.0.1', port, token }, { restart: () => {} });
    memberId = ownInstanceId(db);

    insertMetrics(db, NOW, 20, 3);
    insertPerf(db, NOW, { queries: 30, avg: 3000, p95: 20000, cpu: 12 });
    insertHits(db, NOW);
    const ask = (clientIp, domain, action = 'allowed', failure = null) =>
      logDnsQuery({
        clientIp,
        domain,
        queryType: clientIp.includes(':') ? 'AAAA' : 'A',
        responseCode: failure ? 'SERVFAIL' : 'NOERROR',
        action,
        latencyUs: 1500,
        resolvedIp: failure ? null : '198.51.100.7',
        dnssecSupported: false,
        ede: failure ? 7 : null,
        failure,
      });
    ask('192.0.2.10', 'four.example');
    ask('192.0.2.10', 'four.example');
    ask('2001:db8::10', 'six.example');
    ask('2001:db8::10', 'ads.example', 'blocked_blocklist');
    ask('2001:db8::10', 'broken.example', 'allowed', 'dnssec');
    await flushQueries();
  });

  it('stores both kinds under the member’s id, either address family', async () => {
    const sent = await uploadCollectedOnce(box.db);
    expect(sent).toBe(5 + 5);

    for (const table of [
      'metrics',
      'metrics_blocklist_hits',
      'metrics_geoip_hits',
      'metrics_proxy_perf',
      'metrics_forwarder',
    ]) {
      expect(count(controller, table, `instance_id = '${memberId}'`), table).toBe(1);
    }
    expect(
      controller
        .prepare('SELECT ts, dns_queries, dhcp4_client_msgs FROM metrics WHERE instance_id = ?')
        .get(memberId),
    ).toEqual({ ts: NOW, dns_queries: 20, dhcp4_client_msgs: 3 });
    expect(
      controller
        .prepare('SELECT address, latency_p95_us FROM metrics_forwarder WHERE instance_id = ?')
        .get(memberId),
    ).toEqual({ address: '2001:db8::53', latency_p95_us: 4000 });

    const rows = await queryRaw(
      `SELECT client_ip, domain, query_type, action, latency_us, dnssec_supported, ede, failure, seq
       FROM dns_queries WHERE instance_id = ? ORDER BY domain`,
      [memberId],
    );
    expect(rows.map((row) => `${row.client_ip} ${row.domain}`)).toEqual([
      '2001:db8::10 ads.example',
      '2001:db8::10 broken.example',
      '192.0.2.10 four.example',
      '192.0.2.10 four.example',
      '2001:db8::10 six.example',
    ]);
    expect(rows[1]).toMatchObject({
      query_type: 'AAAA',
      latency_us: 1500,
      dnssec_supported: false,
      ede: 7,
      failure: 'dnssec',
      // The controller's own numbering is for its own rows.
      seq: null,
    });
    // Nothing waits, so nothing goes.
    await expect(uploadCollectedOnce(box.db)).resolves.toBe(0);
  });

  it('stores a batch once when it arrives twice', async () => {
    // The answers were lost: the member's cursors are back where they were.
    box.db.prepare("DELETE FROM sync_state WHERE key LIKE 'collected_cursor:%'").run();
    await uploadCollectedOnce(box.db);
    expect(count(controller, 'metrics', `instance_id = '${memberId}'`)).toBe(1);
    expect(count(controller, 'metrics_proxy_perf', `instance_id = '${memberId}'`)).toBe(1);
    await expect(storedQueries(memberId)).resolves.toBe(5);
    expect(Number(readSyncState(box.db, 'collected_cursor:dns_queries'))).toBeGreaterThan(0);
  });

  it('refuses a malformed row and keeps the good ones around it', async () => {
    const epoch = readSyncState(box.db, 'collected_epoch:metrics_geoip_hits');
    const { position } = controller
      .prepare(
        "SELECT position FROM sync_collected_marks WHERE instance_id = ? AND stream = 'metrics_geoip_hits'",
      )
      .get(memberId);
    const answer = await post('metrics_geoip_hits', {
      epoch,
      rows: [
        [position + 1, NOW, 'AA', 1],
        [position + 2, NOW, 'BB', 'many'],
        [position + 3, NOW, "C'; DROP TABLE x", 1],
        [position + 4, 12, 'DD', 1],
        'not a row',
        [position + 5, NOW, 'EE'],
        [position + 6, NOW, 'FF', 6],
      ],
    });
    expect(answer).toEqual({
      status: 200,
      body: { position: position + 6, taken: 3, skipped: 0, refused: 4 },
    });
    // Text is bound, never read as SQL: stored as sent.
    expect(
      controller
        .prepare('SELECT country, count FROM metrics_geoip_hits WHERE instance_id = ? ORDER BY id')
        .all(memberId)
        .slice(1),
    ).toEqual([
      { country: 'AA', count: 1 },
      { country: "C'; DROP TABLE x", count: 1 },
      { country: 'FF', count: 6 },
    ]);
    expect(count(controller, 'metrics')).toBeGreaterThan(0);
    // The member is not asked for the refused rows again.
    writeSyncState(box.db, 'collected_cursor:metrics_geoip_hits', position + 6);

    const queries = await post('dns_queries', {
      epoch: readSyncState(box.db, 'collected_epoch:dns_queries'),
      rows: [
        [
          9001,
          new Date().toISOString(),
          'not-an-address',
          'x.example',
          'A',
          null,
          'allowed',
          null,
          1,
          null,
          null,
          null,
          null,
        ],
        [
          9002,
          '1999-01-01T00:00:00.000Z',
          '192.0.2.9',
          'old.example',
          'A',
          null,
          'allowed',
          null,
          1,
          null,
          null,
          null,
          null,
        ],
        [
          9003,
          new Date().toISOString(),
          'fe80::1%eth0',
          'ok.example',
          'AAAA',
          'NOERROR',
          'allowed',
          null,
          1,
          null,
          true,
          null,
          null,
        ],
      ],
    });
    expect(queries.body).toMatchObject({ position: 9003, taken: 1, refused: 2 });
    await expect(storedQueries(memberId)).resolves.toBe(6);
  });

  it('ignores an instance id the member names, and a caller with no credential', async () => {
    const other = ownInstanceId(controller);
    const epoch = readSyncState(box.db, 'collected_epoch:metrics_blocklist_hits');
    const answer = await post('metrics_blocklist_hits', {
      epoch,
      instance_id: other,
      rows: [[5000, NOW, 'forged', 9]],
    });
    expect(answer.body.taken).toBe(1);
    expect(
      controller
        .prepare("SELECT instance_id FROM metrics_blocklist_hits WHERE category = 'forged'")
        .all(),
    ).toEqual([{ instance_id: memberId }]);

    expect((await post('metrics', { epoch, rows: [] }, 'made-up')).status).toBe(401);
    expect((await post('users', { epoch, rows: [] })).status).toBe(404);
    expect((await post('metrics', { epoch: 'x', rows: [] })).status).toBe(400);
    const many = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => [i + 1]);
    expect((await post('metrics', { epoch, rows: many })).status).toBeGreaterThanOrEqual(400);
  });

  it('starts a new epoch when the controller holds ids the member has not made yet', async () => {
    // As after a restore on the member: the controller is ahead of it.
    controller
      .prepare(
        "UPDATE sync_collected_marks SET position = 999999 WHERE instance_id = ? AND stream = 'metrics'",
      )
      .run(memberId);
    const epoch = readSyncState(box.db, 'collected_epoch:metrics');
    insertMetrics(box.db, BEFORE, 40, 0);
    await uploadCollectedOnce(box.db);
    expect(readSyncState(box.db, 'collected_epoch:metrics')).not.toBe(epoch);
    expect(
      controller
        .prepare('SELECT dns_queries FROM metrics WHERE instance_id = ? ORDER BY ts')
        .all(memberId),
    ).toEqual([{ dns_queries: 40 }, { dns_queries: 20 }]);
  });

  it('stores a row once when a restored member sends it again under a new epoch', async () => {
    const tables = [
      'metrics',
      'metrics_blocklist_hits',
      'metrics_geoip_hits',
      'metrics_proxy_perf',
      'metrics_forwarder',
    ];
    const held = () =>
      Object.fromEntries(
        tables.map((table) => [table, count(controller, table, `instance_id = '${memberId}'`)]),
      );
    const before = held();
    const queries = await storedQueries(memberId);
    // As after a restore on the member: every cursor back at the start and
    // every epoch new, so the controller's marks start over too.
    box.db
      .prepare(
        "DELETE FROM sync_state WHERE key LIKE 'collected_cursor:%' OR key LIKE 'collected_epoch:%'",
      )
      .run();
    await uploadCollectedOnce(box.db);
    expect(held()).toEqual(before);
    await expect(storedQueries(memberId)).resolves.toBe(queries);
    // The controller's own rows are not keyed: a restart inside one minute
    // still leaves two.
    expect(count(controller, 'metrics', `instance_id IS NULL AND ts = ${NOW}`)).toBe(2);
  });
});

describe('analytics by instance', () => {
  const get = (url) => api.get(url).then((res) => res.body);

  it('adds counts up across instances, and gives one instance its own', async () => {
    const all = await get('/api/metrics/timeseries?range=1h');
    // One row a minute now: the controller's 5 and the member's 40, then 7 + 1 + 20.
    expect(all.map((row) => [row.ts, row.dns_queries])).toEqual([
      [BEFORE, 45],
      [NOW, 28],
    ]);
    expect(all[1].dhcp4_client_msgs).toBe(5);

    const member = await get(`/api/metrics/timeseries?range=1h&instance=${memberId}`);
    expect(member.map((row) => row.dns_queries)).toEqual([40, 20]);
    const own = await get(`/api/metrics/timeseries?range=1h&instance=${ownInstanceId(controller)}`);
    expect(own.map((row) => row.dns_queries)).toEqual([5, 7, 1]);

    expect(await get('/api/metrics/blocklist-hits?range=1h')).toEqual([
      { category: 'forged', count: 9 },
      { category: 'ads', count: 8 },
    ]);
    expect(await get(`/api/metrics/geoip-hits?range=1h&instance=${memberId}`)).toHaveLength(4);
    expect(await get('/api/metrics/forwarder?range=1h')).toHaveLength(2);
    expect(await get(`/api/metrics/forwarder?range=1h&instance=${memberId}`)).toHaveLength(1);
  });

  it('refuses an instance it does not know, on every kind of read', async () => {
    for (const url of [
      '/api/metrics/timeseries',
      '/api/metrics/blocklist-hits',
      '/api/metrics/geoip-hits',
      '/api/metrics/proxy-perf',
      '/api/metrics/forwarder',
      '/api/metrics/dns-failures',
      '/api/analytics/top-clients',
      '/api/analytics/blocklist/top-domains',
      '/api/analytics/query-volume',
      '/api/analytics/action-breakdown',
      '/api/analytics/client/192.0.2.10/domains',
      '/api/analytics/domain/four.example/clients',
    ]) {
      const res = await api.get(`${url}?instance=11111111-2222-3333-4444-555555555555`);
      expect(res.status, url).toBe(400);
      expect(res.body.code).toBe('unknown_instance');
      expect((await api.get(`${url}?instance=all`)).status, url).toBe(200);
    }
    expect((await api.get("/api/metrics/timeseries?instance=' OR 1=1 --")).status).toBe(400);
  });

  it('does not merge a percentile: each instance keeps its own', async () => {
    const all = await get('/api/metrics/proxy-perf?range=1h');
    const now = all.find((row) => row.ts === NOW);
    expect(now).toMatchObject({
      query_count: 40,
      cache_hits: 6,
      servfail_dnssec: 2,
      latency_min: 100,
      latency_max: 40000,
      // (10 x 1000 + 30 x 3000) / 40
      latency_avg: 2500,
      latency_p95: null,
      cpu_percent: null,
      rss_mb: null,
    });
    // A minute one instance measured alone is that instance's, whole.
    expect(all.find((row) => row.ts === BEFORE)).toMatchObject({
      query_count: 5,
      latency_p95: 9000,
      cpu_percent: 3.5,
    });

    const each = await get('/api/metrics/proxy-perf?range=1h&by=instance');
    expect(each.map((group) => group.instance_id).sort()).toEqual(
      [memberId, ownInstanceId(controller)].sort(),
    );
    const theirs = each.find((group) => group.instance_id === memberId);
    expect(theirs.name).toBe(
      controller.prepare('SELECT name FROM sync_instances WHERE instance_id = ?').get(memberId)
        .name,
    );
    expect(theirs.rows).toEqual([
      expect.objectContaining({ ts: NOW, latency_p95: 20000, cpu_percent: 12 }),
    ]);
    const ours = each.find((group) => group.instance_id !== memberId);
    expect(ours.rows.map((row) => row.latency_p95)).toEqual([9000, 5000, null]);
    expect(ours.rows[0]).not.toHaveProperty('instance_id');

    const one = await get(`/api/metrics/proxy-perf?range=1h&instance=${memberId}`);
    expect(one).toEqual([expect.objectContaining({ latency_p95: 20000, rss_mb: 80.5 })]);
  });

  it('counts the stored queries of every instance, or of one', async () => {
    const own = ownInstanceId(controller);
    const top = (rows) => Object.fromEntries(rows.map((row) => [row.client_ip, row.count]));
    // Each query is there twice: once as this box's own, once from the member.
    expect(top(await get('/api/analytics/top-clients?range=1h'))).toEqual({
      '2001:db8::10': 6,
      '192.0.2.10': 4,
      'fe80::1%eth0': 1,
    });
    expect(top(await get(`/api/analytics/top-clients?range=1h&instance=${memberId}`))).toEqual({
      '2001:db8::10': 3,
      '192.0.2.10': 2,
      'fe80::1%eth0': 1,
    });
    expect(top(await get(`/api/analytics/top-clients?range=1h&instance=${own}`))).toEqual({
      '2001:db8::10': 3,
      '192.0.2.10': 2,
    });

    expect(await get(`/api/analytics/blocklist/top-domains?range=1h&instance=${memberId}`)).toEqual(
      [{ domain: 'ads.example', count: 1 }],
    );
    expect(await get('/api/analytics/blocklist/top-domains?range=1h')).toEqual([
      { domain: 'ads.example', count: 2 },
    ]);
    const volume = await get(`/api/analytics/query-volume?range=1h&interval=1h&instance=${own}`);
    expect(volume.reduce((sum, row) => sum + row.total, 0)).toBe(5);
    expect(await get(`/api/analytics/action-breakdown?range=1h&instance=${memberId}`)).toEqual([
      { action: 'allowed', count: 5 },
      { action: 'blocked_blocklist', count: 1 },
    ]);
    expect(
      await get(`/api/analytics/client/2001:db8::10/domains?range=1h&instance=${own}`),
    ).toHaveLength(3);
    expect(await get('/api/analytics/domain/six.example/clients?range=1h')).toEqual([
      expect.objectContaining({ client_ip: '2001:db8::10', count: 2 }),
    ]);
    expect(await get(`/api/metrics/dns-failures?range=1h&instance=${memberId}`)).toEqual([
      { domain: 'broken.example', count: 1, failure: 'dnssec', ede: 7 },
    ]);
    expect((await get('/api/metrics/dns-failures?range=1h'))[0].count).toBe(2);
  });

  it('keeps the anomaly evidence to this box’s own queries', async () => {
    const { queryClientWindowSummary } = await import('../../src/db/duckdb.js');
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const summary = await queryClientWindowSummary('2001:db8::10', from, to);
    expect(summary.total_queries).toBe(3);
  });

  it('lists the member beside the controller', async () => {
    const instances = await get('/api/analytics/instances');
    expect(instances.map((row) => row.instance_id)).toContain(memberId);
    expect(instances.filter((row) => row.is_self)).toHaveLength(1);
  });
});
