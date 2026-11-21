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
