/**
 * Migration 098 and the analytics database's own in-place change: rows know
 * the instance that measured them, and what an upgraded single box already
 * holds is left as it was.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import { databaseThrough } from '../helpers/migrations.js';
import {
  closeAnalyticsDb,
  flushQueries,
  initAnalyticsDb,
  logDnsQuery,
  queryRaw,
  queryTopClients,
  readOwnQueriesAfter,
} from '../../src/db/duckdb.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  'metrics',
  'metrics_blocklist_hits',
  'metrics_geoip_hits',
  'metrics_proxy_perf',
  'metrics_forwarder',
];

describe('migration 098: the metrics tables', () => {
  it('keeps every stored row, as this box’s own', () => {
    const { db, migrate } = databaseThrough(97, { tmpDirs });
    db.prepare('INSERT INTO metrics (ts, dns_queries) VALUES (1000, 5)').run();
    db.prepare("INSERT INTO metrics_geoip_hits (ts, country, count) VALUES (1000, 'ZZ', 2)").run();
    const before = db.prepare('SELECT * FROM metrics').all();

    migrate(98);

    expect(db.prepare('SELECT * FROM metrics').all()).toEqual([
      { ...before[0], instance_id: null },
    ]);
    for (const table of TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      expect(
        columns.map((column) => column.name),
        table,
      ).toContain('instance_id');
    }
    // The indexes hold members' rows only: nothing on a single box.
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT 1 FROM metrics_proxy_perf WHERE instance_id IS NOT NULL LIMIT 1',
      )
      .all();
    expect(plan[0].detail).toContain('idx_proxy_perf_instance');
    expect(db.prepare('SELECT count(*) AS n FROM sync_collected_marks').get().n).toBe(0);
  });

  it('runs on a new install', () => {
    const { db, migrate } = databaseThrough(97, { tmpDirs });
    expect(() => migrate(98)).not.toThrow();
    db.prepare('INSERT INTO metrics (ts, dns_queries) VALUES (1, 1)').run();
    expect(db.prepare('SELECT instance_id FROM metrics').get()).toEqual({ instance_id: null });
  });
});

describe('migration 101: a member’s row is stored once', () => {
  const member = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('keeps the first of each member row already stored twice, and every own row', () => {
    const { db, migrate } = databaseThrough(100, { tmpDirs });
    const metrics = db.prepare(
      'INSERT INTO metrics (ts, dns_queries, instance_id) VALUES (?, ?, ?)',
    );
    metrics.run(60, 1, null);
    metrics.run(60, 2, null);
    metrics.run(60, 3, member);
    metrics.run(60, 3, member);
    metrics.run(120, 4, member);
    const geo = db.prepare(
      'INSERT INTO metrics_geoip_hits (ts, country, count, instance_id) VALUES (?, ?, ?, ?)',
    );
    geo.run(60, 'ZZ', 1, member);
    geo.run(60, 'ZZ', 1, member);
    geo.run(60, 'YY', 1, member);
    const forwarder = db.prepare(
      `INSERT INTO metrics_forwarder (ts, provider, address, protocol, queries, instance_id)
       VALUES (60, 'dns.example', ?, 'dot', 1, ?)`,
    );
    forwarder.run('', member);
    forwarder.run('', member);
    forwarder.run('2001:db8::53', member);
    forwarder.run('192.0.2.53', member);

    expect(() => migrate(101)).not.toThrow();

    expect(
      db.prepare('SELECT id, ts, dns_queries, instance_id FROM metrics ORDER BY id').all(),
    ).toEqual([
      { id: 1, ts: 60, dns_queries: 1, instance_id: null },
      { id: 2, ts: 60, dns_queries: 2, instance_id: null },
      { id: 3, ts: 60, dns_queries: 3, instance_id: member },
      { id: 5, ts: 120, dns_queries: 4, instance_id: member },
    ]);
    expect(db.prepare('SELECT country FROM metrics_geoip_hits ORDER BY id').pluck().all()).toEqual([
      'ZZ',
      'YY',
    ]);
    expect(db.prepare('SELECT address FROM metrics_forwarder ORDER BY id').pluck().all()).toEqual([
      '',
      '2001:db8::53',
      '192.0.2.53',
    ]);

    // A member row a second time is refused; an own row is not.
    expect(() => metrics.run(60, 9, member)).toThrow(/UNIQUE/);
    expect(
      db
        .prepare('INSERT OR IGNORE INTO metrics (ts, dns_queries, instance_id) VALUES (60, 9, ?)')
        .run(member).changes,
    ).toBe(0);
    expect(() => metrics.run(60, 9, null)).not.toThrow();
  });

  it('runs on a new install', () => {
    const { migrate } = databaseThrough(100, { tmpDirs });
    expect(() => migrate(101)).not.toThrow();
  });
});

describe('the analytics database', () => {
  it('opens one from before the instance column, and numbers only new rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duckdb-instance-'));
    tmpDirs.push(dir);
    // As 0.6.x left it.
    const old = await DuckDBInstance.create(path.join(dir, 'analytics.duckdb'));
    const connection = await old.connect();
    await connection.run(`
      CREATE TABLE dns_queries (
        ts TIMESTAMP NOT NULL, client_ip VARCHAR NOT NULL, domain VARCHAR NOT NULL,
        query_type VARCHAR NOT NULL, response_code VARCHAR, action VARCHAR NOT NULL,
        block_reason VARCHAR, latency_us INTEGER, resolved_ip VARCHAR,
        dnssec_supported BOOLEAN, ede INTEGER, failure VARCHAR
      )`);
    await connection.run(
      `INSERT INTO dns_queries (ts, client_ip, domain, query_type, action) VALUES
         (NOW()::TIMESTAMP, '192.0.2.1', 'old.example', 'A', 'allowed'),
         (NOW()::TIMESTAMP, '2001:db8::1', 'old.example', 'AAAA', 'allowed')`,
    );
    connection.closeSync();
    old.closeSync();

    await initAnalyticsDb(dir);
    try {
      logDnsQuery({ clientIp: '2001:db8::2', domain: 'new.example', queryType: 'AAAA' });
      logDnsQuery({ clientIp: '192.0.2.2', domain: 'new.example' });
      await flushQueries();

      expect(
        await queryRaw(
          'SELECT domain, instance_id, seq FROM dns_queries ORDER BY seq NULLS FIRST, client_ip',
        ),
      ).toEqual([
        { domain: 'old.example', instance_id: null, seq: null },
        { domain: 'old.example', instance_id: null, seq: null },
        { domain: 'new.example', instance_id: null, seq: 1 },
        { domain: 'new.example', instance_id: null, seq: 2 },
      ]);
      // Old and new count alike.
      expect(await queryTopClients('1h', 10)).toHaveLength(4);
      // What a member would send up: the rows stored since, in order.
      const waiting = await readOwnQueriesAfter(1, 10);
      expect(waiting).toHaveLength(1);
      expect(waiting[0][0]).toBe(2);
      expect(waiting[0].slice(2, 5)).toEqual(['192.0.2.2', 'new.example', 'A']);
    } finally {
      await closeAnalyticsDb();
    }
  });
});
