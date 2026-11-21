/**
 * The collected data a member sends up to its controller
 * (docs/REDUNDANCY-PLAN.md, section 4): the five metrics tables and the DNS
 * query log. One stream each, and one definition of it for both ends: what
 * the member reads and what the controller will store.
 *
 * A row travels as an array: the member's own id for it first, then its
 * values in the stream's column order. The id only ever grows, which is the
 * whole protocol: the member sends rows after its cursor, and the controller
 * keeps, per member and stream, the highest id it has stored (its mark) and
 * skips anything at or below it. So a batch that arrives twice, because the
 * answer to the first was lost, is stored once. A mark belongs to an epoch,
 * a random id the member renews when its ids start over (a rebuilt analytics
 * database, a restored backup); a new epoch starts the mark at 0.
 *
 * Everything a member sends is checked here before it is stored: a value of
 * the wrong type or size refuses its row, and the rest of the batch stands.
 */
import {
  analyticsRetentionDays,
  ownQueriesHead,
  readOwnQueriesAfter,
  storeMemberQueries,
} from '../db/duckdb.js';
import { METRICS_RETENTION_DAYS } from '../config/defaults.js';
import { isValidIp } from '../utils/address.js';

/** The most rows one request may carry. */
export const MAX_BATCH_ROWS = 2000;

const DAY_MS = 86_400_000;
// A member's clock may run a little ahead; a row from further in the future
// is refused, since no retention would ever reach it.
const AHEAD_MS = DAY_MS;

const BAD = Symbol('bad');
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

// One checker per kind of value: the value as stored, or BAD.
const whole = (max) => (v) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : BAD);
const optional = (check) => (v) => (v === null || v === undefined ? null : check(v));
const count = optional(whole(MAX_COUNT));
// DuckDB stores these as 32-bit integers.
const int32 = optional(whole(2 ** 31 - 1));
const real = optional((v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : BAD));
const text = (max) => (v) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : BAD);
const flag = optional((v) => (typeof v === 'boolean' ? v : BAD));
// Either family, with the interface a link-local address was seen on; empty
// when the proxy could not tell.
const address = (v) =>
  v === '' || (typeof v === 'string' && v.length <= 64 && isValidIp(v.split('%')[0])) ? v : BAD;

// Epoch seconds, minute rows.
const metricTime = (v) => {
  const now = Date.now();
  return Number.isSafeInteger(v) &&
    v * 1000 >= now - (METRICS_RETENTION_DAYS + 1) * DAY_MS &&
    v * 1000 <= now + AHEAD_MS
    ? v
    : BAD;
};
// An ISO time, stored the way logDnsQuery writes its own.
const queryTime = (v) => {
  const at = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
  const now = Date.now();
  return at >= now - (analyticsRetentionDays() + 1) * DAY_MS && at <= now + AHEAD_MS
    ? new Date(at).toISOString()
    : BAD;
};

const counts = (...names) => names.map((name) => [name, count]);

/** A metrics table as a stream: rows by their id, in SQLite. */
function metricsStream(table, columns) {
  const names = columns.map(([name]) => name);
  return {
    name: table,
    columns,
    read: (db, after, limit) =>
      db
        .prepare(
          `SELECT id, ${names.join(', ')} FROM ${table}
           WHERE instance_id IS NULL AND id > ? ORDER BY id LIMIT ?`,
        )
        .raw()
        .all(after, limit),
    // AUTOINCREMENT: the highest id ever given, kept through every prune.
    head: (db) => db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq || 0,
    store(db, instanceId, epoch, accept) {
      const insert = db.prepare(
        `INSERT INTO ${table} (${names.join(', ')}, instance_id)
         VALUES (${names.map(() => '?').join(', ')}, ?)`,
      );
      return db.transaction(() => {
        const mark = db
          .prepare(
            'SELECT epoch, position FROM sync_collected_marks WHERE instance_id = ? AND stream = ?',
          )
          .get(instanceId, table);
        const accepted = accept(mark && mark.epoch === epoch ? mark.position : 0);
        for (const row of accepted.rows) insert.run(...row, instanceId);
        db.prepare(
          `INSERT INTO sync_collected_marks (instance_id, stream, epoch, position)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(instance_id, stream) DO UPDATE
             SET epoch = excluded.epoch, position = excluded.position`,
        ).run(instanceId, table, epoch, accepted.position);
        return accepted;
      })();
    },
  };
}

export const STREAMS = [
  metricsStream('metrics', [
    ['ts', metricTime],
    ...counts(
      'dns_queries',
      'dhcp_requests',
      'dhcp_client_msgs',
      'dhcp_server_msgs',
      'dhcp4_client_msgs',
      'dhcp4_server_msgs',
      'dhcp6_client_msgs',
      'dhcp6_server_msgs',
      'blocklist_blocks',
      'geoip_blocks',
    ),
  ]),
  metricsStream('metrics_blocklist_hits', [
    ['ts', metricTime],
    ['category', text(100)],
    ['count', count],
  ]),
  metricsStream('metrics_geoip_hits', [
    ['ts', metricTime],
    ['country', text(16)],
    ['count', count],
  ]),
  metricsStream('metrics_proxy_perf', [
    ['ts', metricTime],
    ...counts(
      'query_count',
      'latency_min',
      'latency_avg',
      'latency_max',
      'latency_p95',
      'cache_hits',
      'cache_misses',
      'timeouts',
      'pending_queries',
    ),
    ['cpu_percent', real],
    ['rss_mb', real],
    ['heap_mb', real],
    ...counts(
      'startup_ms',
      'servfail_dnssec',
      'servfail_upstream',
      'servfail_timeout',
      'servfail_refused',
      'servfail_other',
      'nxdomain',
    ),
  ]),
  metricsStream('metrics_forwarder', [
    ['ts', metricTime],
    ['provider', text(253)],
    // Empty on a provider's own row, the one holding its failovers.
    ['address', (v) => (v === '' ? v : text(64)(v))],
    ['protocol', text(8)],
    ...counts(
      'queries',
      'answers',
      'timeouts',
      'drops',
      'connect_failures',
      'failovers',
      'latency_p50_us',
      'latency_p95_us',
    ),
  ]),
  {
    name: 'dns_queries',
    // db/duckdb.js QUERY_COLUMNS, in its order.
    columns: [
      ['ts', queryTime],
      ['client_ip', address],
      ['domain', (v) => (v === '' ? v : text(255)(v))],
      ['query_type', text(16)],
      ['response_code', optional(text(16))],
      ['action', text(32)],
      ['block_reason', optional(text(100))],
      ['latency_us', int32],
      ['resolved_ip', optional(text(64))],
      ['dnssec_supported', flag],
      ['ede', optional(whole(65535))],
      ['failure', optional(text(32))],
    ],
    read: (db, after, limit) => readOwnQueriesAfter(after, limit),
    head: () => ownQueriesHead(),
    store: (db, instanceId, epoch, accept) => storeMemberQueries(instanceId, epoch, accept),
  },
];

export const streamNamed = (name) => STREAMS.find((stream) => stream.name === name) || null;

/**
 * What a batch from a member comes to, for a store that is at `position`:
 * { rows, position, taken, skipped, refused }. `rows` are the ones to store,
 * values in column order without the id. A row at or below the position was
 * stored before and is skipped; one that fails a check is refused. Either
 * way the position moves past it, so the member never sends it again.
 */
export function acceptBatch(stream, batch, position) {
  const out = { rows: [], position, taken: 0, skipped: 0, refused: 0 };
  for (const row of batch) {
    const id = Array.isArray(row) ? row[0] : null;
    // Not a row of this protocol at all: nothing to move past.
    if (!Number.isSafeInteger(id) || id < 1) {
      out.refused++;
      continue;
    }
    if (id <= out.position) {
      out.skipped++;
      continue;
    }
    out.position = id;
    const values =
      row.length === stream.columns.length + 1
        ? stream.columns.map(([, check], i) => check(row[i + 1]))
        : [BAD];
    if (values.includes(BAD)) {
      out.refused++;
      continue;
    }
    out.rows.push(values);
    out.taken++;
  }
  return out;
}
