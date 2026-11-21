import path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  DATA_DIR,
  ANALYTICS_FLUSH_INTERVAL_MS,
  ANALYTICS_RETENTION_CLEANUP_MS,
} from '../config/defaults.js';
import { getSetting } from './init.js';

let instance = null;
let connection = null;
// Members' rows go in on a connection of their own: a batch and its mark are
// one transaction, which the flush on the main connection must stay out of.
let ingest = null;
let ingestQueue = Promise.resolve();
let buffer = [];
let flushTimer = null;
let pruneTimer = null;

// Initialize DuckDB analytics database
export function initAnalyticsDb(dataDir) {
  const dbPath = path.join(dataDir || DATA_DIR, 'analytics.duckdb');

  return (async () => {
    // Cap DuckDB's buffer-pool memory before any query can run.
    // Default is ~80% of system RAM (≈819MB on a 1GB LXC), which combined
    // with the Node heap, the in-memory blocklist, and the Python anomaly
    // daemon's resident set will push the cgroup over its limit and trigger
    // the kernel OOM-killer on cidrella.service. The 17MB on-disk analytics
    // dataset doesn't need a 256MB working set today, but headroom is cheap
    // and a future ~10× growth still fits. threads=2 caps per-thread scratch
    // so a single heavy GROUP BY can't spike RSS on a small box.
    instance = await DuckDBInstance.create(dbPath, {
      memory_limit: '256MB',
      threads: '2',
    });
    connection = await instance.connect();

    await connection.run(`
      CREATE TABLE IF NOT EXISTS dns_queries (
        ts TIMESTAMP NOT NULL,
        client_ip VARCHAR NOT NULL,
        domain VARCHAR NOT NULL,
        query_type VARCHAR NOT NULL,
        response_code VARCHAR,
        action VARCHAR NOT NULL,
        block_reason VARCHAR,
        latency_us INTEGER,
        resolved_ip VARCHAR,
        dnssec_supported BOOLEAN,
        ede INTEGER,
        failure VARCHAR
      )
    `);

    // DuckDB analytics schema changes are applied in place because this file
    // is an independent, rebuildable event store rather than the canonical
    // SQLite database managed by numbered migrations.
    // ede is the answer's Extended DNS Error code and failure its cause
    // (utils/dns-ede.js failureCause), both null on an answer that worked.
    // instance_id is the member a row came up from, NULL for a query this box
    // answered itself (every row on a single box, and every row from before
    // the column). seq numbers this box's own rows in the order they were
    // stored, which is how a member knows what it has sent up; a row's ts is
    // when the query was answered, and a row can be stored late.
    for (const column of [
      'dnssec_supported BOOLEAN',
      'ede INTEGER',
      'failure VARCHAR',
      'instance_id VARCHAR',
      'seq BIGINT',
    ]) {
      await connection.run(`ALTER TABLE dns_queries ADD COLUMN IF NOT EXISTS ${column}`);
    }
    await connection.run('CREATE SEQUENCE IF NOT EXISTS dns_queries_seq');
    // How far into each member's rows this box has stored (the controller's
    // side of sync/collected-streams.js).
    await connection.run(`
      CREATE TABLE IF NOT EXISTS collected_marks (
        instance_id VARCHAR NOT NULL,
        epoch VARCHAR NOT NULL,
        position BIGINT NOT NULL
      )
    `);
    ingest = await instance.connect();

    // Start periodic flush
    flushTimer = setInterval(() => flushQueries(), ANALYTICS_FLUSH_INTERVAL_MS);

    // Start periodic pruning
    pruneTimer = setInterval(() => pruneOldData(), ANALYTICS_RETENTION_CLEANUP_MS);

    console.log('[analytics] DuckDB initialized', { path: dbPath });
  })();
}

// Buffer a DNS query for batch insert
export function logDnsQuery({
  clientIp,
  domain,
  queryType,
  responseCode,
  action,
  blockReason,
  latencyUs,
  resolvedIp,
  dnssecSupported,
  ede,
  failure,
  // When the query was answered, for a row that waited in the DNS proxy's
  // outbox; now otherwise.
  ts,
}) {
  if (!connection) return;
  buffer.push({
    ts: ts || new Date().toISOString(),
    clientIp: clientIp || '',
    domain: domain || '',
    queryType: queryType || 'A',
    responseCode: responseCode || null,
    action: action || 'allowed',
    blockReason: blockReason || null,
    latencyUs: latencyUs != null ? Math.round(latencyUs) : null,
    resolvedIp: resolvedIp || null,
    dnssecSupported: typeof dnssecSupported === 'boolean' ? dnssecSupported : null,
    ede: Number.isInteger(ede) ? ede : null,
    failure: failure || null,
  });
}

// Buffer fields in INSERT column order.
const QUERY_COLUMNS = [
  ['ts', 'ts'],
  ['client_ip', 'clientIp'],
  ['domain', 'domain'],
  ['query_type', 'queryType'],
  ['response_code', 'responseCode'],
  ['action', 'action'],
  ['block_reason', 'blockReason'],
  ['latency_us', 'latencyUs'],
  ['resolved_ip', 'resolvedIp'],
  ['dnssec_supported', 'dnssecSupported'],
  ['ede', 'ede'],
  ['failure', 'failure'],
];
const QUERY_COLUMN_NAMES = QUERY_COLUMNS.map(([column]) => column).join(', ');
const QUERY_PLACEHOLDERS = QUERY_COLUMNS.map(() => '?').join(', ');
const QUERY_TUPLE = `(${QUERY_PLACEHOLDERS}, nextval('dns_queries_seq'))`;

// Flush buffered queries to DuckDB using batched multi-row INSERT
export function flushQueries() {
  if (!connection || buffer.length === 0) return;

  const rows = buffer.splice(0, buffer.length);

  // Build a single INSERT with multiple value tuples and a flat params array
  const placeholders = [];
  const params = [];
  for (const row of rows) {
    placeholders.push(QUERY_TUPLE);
    for (const [, field] of QUERY_COLUMNS) params.push(row[field]);
  }

  const sql = `INSERT INTO dns_queries (${QUERY_COLUMN_NAMES}, seq) VALUES ${placeholders.join(', ')}`;

  return connection
    .run(sql, params)
    .catch((err) => console.error('[analytics] Flush error:', err.message));
}

/** Every instance's rows: the filter that filters nothing. */
export const EVERY_INSTANCE = Object.freeze({ and: '', params: [] });

// Validated range-to-interval mapping, only allows known safe values
const VALID_INTERVALS = new Map();
for (const n of [1, 5, 10, 15, 30, 60]) VALID_INTERVALS.set(`${n}m`, `${n} MINUTES`);
for (const n of [1, 2, 4, 6, 12, 24, 48, 72]) VALID_INTERVALS.set(`${n}h`, `${n} HOURS`);
for (const n of [1, 2, 3, 7, 14, 30, 90]) VALID_INTERVALS.set(`${n}d`, `${n} DAYS`);
VALID_INTERVALS.set('1w', '7 DAYS');

function rangeToInterval(range) {
  return VALID_INTERVALS.get(range || '24h') || '24 HOURS';
}

// Helper to run a DuckDB query and return rows
// Converts BigInt values to Number for JSON serialization
export function queryRaw(sql, params = []) {
  if (!connection) return Promise.resolve([]);
  return connection
    .runAndReadAll(sql, params)
    .then((reader) => reader.getRowObjectsJS().map(safeRowForJson));
}

function safeRowForJson(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

// Every range query below takes `instance` last: whose rows to count, from
// readInstanceFilter (sync/instance-filter.js). Every instance's by default.
// These are counts over the stored queries themselves, so every instance
// together is one honest count.

// This box's own rows: what the anomaly evidence reads, as the sidecar that
// scored the window did (routes/internal-analytics.js).
const OWN = 'instance_id IS NULL';

// Generic top-N query by column (no action filter)
function queryTopBy(column, range, limit = 20, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT ${column}, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'${instance.and}
     GROUP BY ${column}
     ORDER BY count DESC
     LIMIT ?`,
    [...instance.params, limit],
  );
}

// Generic top-N query by column filtered by action
function queryTopByAction(column, range, action, limit = 10, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT ${column}, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?${instance.and}
     GROUP BY ${column}
     ORDER BY count DESC
     LIMIT ?`,
    [action, ...instance.params, limit],
  );
}

// Top clients by query count
export function queryTopClients(range, limit = 20, instance) {
  return queryTopBy('client_ip', range, limit, instance);
}

// Top queried domains
export function queryTopDomains(range, limit = 20, instance) {
  return queryTopBy('domain', range, limit, instance);
}

// Most-requested domains whose successful answers were proven insecure by
// the validating resolver. NULL means no conclusion was possible (for
// example, validation was disabled), so it is deliberately excluded.
export function queryTopDomainsWithoutDnssec(range, limit = 10, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = 'allowed'
       AND response_code = 'NOERROR'
       AND dnssec_supported = FALSE${instance.and}
     GROUP BY domain
     ORDER BY count DESC, domain ASC
     LIMIT ?`,
    [...instance.params, limit],
  );
}

// The names whose answers failed most, with the cause and the EDE code seen
// most for each (utils/dns-ede.js).
export function queryFailedDomains(range, limit = 10, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count, mode(failure) as failure, mode(ede) as ede
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND failure IS NOT NULL${instance.and}
     GROUP BY domain
     ORDER BY count DESC, domain ASC
     LIMIT ?`,
    [...instance.params, limit],
  );
}

// Top clients filtered by action
export function queryTopClientsByAction(range, action, limit = 10, instance) {
  return queryTopByAction('client_ip', range, action, limit, instance);
}

// Top domains filtered by action
export function queryTopDomainsByAction(range, action, limit = 10, instance) {
  return queryTopByAction('domain', range, action, limit, instance);
}

// Top block reasons (category slugs or country codes) for a given action
export function queryTopBlockReasons(range, action, limit = 10, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT block_reason, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?
       AND block_reason IS NOT NULL${instance.and}
     GROUP BY block_reason
     ORDER BY count DESC
     LIMIT ?`,
    [action, ...instance.params, limit],
  );
}

// Top client/domain pairs for a given action
export function queryTopClientDomainPairsByAction(
  range,
  action,
  limit = 20,
  instance = EVERY_INSTANCE,
) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT client_ip, domain, block_reason, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?${instance.and}
     GROUP BY client_ip, domain, block_reason
     ORDER BY count DESC
     LIMIT ?`,
    [action, ...instance.params, limit],
  );
}

// Top blocked domains
export function queryTopBlocked(range, limit = 20, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, action, block_reason, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action != 'allowed'${instance.and}
     GROUP BY domain, action, block_reason
     ORDER BY count DESC
     LIMIT ?`,
    [...instance.params, limit],
  );
}

// Query volume over time (bucketed)
export function queryVolume(range, interval = '5m', instance = EVERY_INSTANCE) {
  const rangeInterval = rangeToInterval(range);
  const bucketInterval = rangeToInterval(interval);
  return queryRaw(
    `SELECT time_bucket(INTERVAL '${bucketInterval}', ts) as bucket,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE action = 'allowed') as allowed,
            COUNT(*) FILTER (WHERE action != 'allowed') as blocked
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${rangeInterval}'${instance.and}
     GROUP BY bucket
     ORDER BY bucket`,
    instance.params,
  );
}

// Action breakdown (counts per action type)
export function queryActionBreakdown(range, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT action, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'${instance.and}
     GROUP BY action
     ORDER BY count DESC`,
    instance.params,
  );
}

// Domains queried by a specific client
export function queryClientDomains(clientIp, range, limit = 50, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND client_ip = ?${instance.and}
     GROUP BY domain
     ORDER BY count DESC
     LIMIT ?`,
    [clientIp, ...instance.params, limit],
  );
}

// The DNS traffic behind one scored anomaly window: what the client actually
// asked for between window_start and window_end, grouped so a 4,000 query
// window reads as a handful of rows.
//
// Bounds are half-open (>= start, < end) to match the daemon's own feature
// extraction (internal-analytics.js 'anomaly-client-window-events'), so the
// rows here are the same rows that produced the score. Both sides compare a
// SQLite UTC datetime string against DuckDB's timezone-naive TIMESTAMP, which
// lines up because logDnsQuery writes toISOString().
export function queryClientWindowEvidence(clientIp, windowStart, windowEnd, limit = 50) {
  return queryRaw(
    `SELECT domain, query_type, response_code, action,
            COUNT(*) as count,
            MIN(ts) as first_seen,
            MAX(ts) as last_seen
     FROM dns_queries
     WHERE client_ip = ?
       AND ts >= CAST(? AS TIMESTAMP)
       AND ts < CAST(? AS TIMESTAMP)
       AND ${OWN}
     GROUP BY domain, query_type, response_code, action
     ORDER BY count DESC, domain
     LIMIT ?`,
    [clientIp, windowStart, windowEnd, limit],
  );
}

// Every distinct name a client asked for in the window, with the counts the
// per-signal evidence ranks on (server/src/utils/anomaly-evidence.js). One row
// per name, capped high: a DGA hour is thousands of names queried once each,
// and the top-by-count list above never shows them.
export function queryClientWindowDomains(clientIp, windowStart, windowEnd, cap = 5000) {
  return queryRaw(
    `SELECT domain,
            COUNT(*) as count,
            COUNT(*) FILTER (WHERE response_code = 'NXDOMAIN') as nxdomain_count,
            COUNT(*) FILTER (WHERE action LIKE 'blocked%') as blocked_count,
            COUNT(*) FILTER (WHERE query_type NOT IN ('A', 'AAAA')) as other_type_count,
            COUNT(*) FILTER (WHERE resolved_ip IS NULL) as unresolved_count,
            COUNT(DISTINCT resolved_ip) as resolved_ip_count
     FROM dns_queries
     WHERE client_ip = ?
       AND ts >= CAST(? AS TIMESTAMP)
       AND ts < CAST(? AS TIMESTAMP)
       AND ${OWN}
     GROUP BY domain
     ORDER BY count DESC, domain
     LIMIT ?`,
    [clientIp, windowStart, windowEnd, cap],
  );
}

// Names in the window this client had not asked for in the lookback before
// it: the sidecar's new_domain_ratio, spelled out (features.py fills that
// ratio from 'anomaly-client-historical-domains' with the same bounds).
export function queryClientNewDomains(clientIp, windowStart, windowEnd, lookbackDays, limit) {
  return queryRaw(
    `SELECT w.domain, COUNT(*) as count
     FROM dns_queries w
     WHERE w.client_ip = ?
       AND w.ts >= CAST(? AS TIMESTAMP)
       AND w.ts < CAST(? AS TIMESTAMP)
       AND w.${OWN}
       AND NOT EXISTS (
         SELECT 1 FROM dns_queries h
          WHERE h.client_ip = w.client_ip AND h.domain = w.domain AND h.${OWN}
            AND h.ts >= CAST(? AS TIMESTAMP) - INTERVAL (CAST(? AS INTEGER) || ' days')
            AND h.ts < CAST(? AS TIMESTAMP))
     GROUP BY w.domain
     ORDER BY count DESC, w.domain
     LIMIT ?`,
    [clientIp, windowStart, windowEnd, windowStart, lookbackDays, windowStart, limit],
  );
}

// Totals for the same window. Separate from the grouped rows above because
// those are truncated by LIMIT, and a summary computed from a truncated list
// would understate every count.
export function queryClientWindowSummary(clientIp, windowStart, windowEnd) {
  return queryRaw(
    `SELECT COUNT(*) as total_queries,
            COUNT(DISTINCT domain) as distinct_domains,
            COUNT(*) FILTER (WHERE response_code = 'NXDOMAIN') as nxdomain_count,
            COUNT(*) FILTER (WHERE action LIKE 'blocked%') as blocked_count
     FROM dns_queries
     WHERE client_ip = ?
       AND ts >= CAST(? AS TIMESTAMP)
       AND ts < CAST(? AS TIMESTAMP)
       AND ${OWN}`,
    [clientIp, windowStart, windowEnd],
  ).then((rows) => rows[0] || null);
}

// Clients that queried a specific domain
export function queryDomainClients(domain, range, limit = 50, instance = EVERY_INSTANCE) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT client_ip, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND domain = ?${instance.and}
     GROUP BY client_ip
     ORDER BY count DESC
     LIMIT ?`,
    [domain, ...instance.params, limit],
  );
}

/** How many days of queries this box keeps (the analytics_retention_days setting). */
export function analyticsRetentionDays() {
  return Math.max(1, Math.min(365, parseInt(getSetting('analytics_retention_days'), 10) || 7));
}

const UPLOAD_COLUMNS = `seq, ${QUERY_COLUMN_NAMES}`;

/**
 * This box's own rows stored after `seq`, oldest first, each an array in
 * UPLOAD_COLUMNS order with ts as an ISO string: what a member sends up
 * (sync/collected-streams.js).
 */
export async function readOwnQueriesAfter(seq, limit) {
  if (!connection) return [];
  const reader = await connection.runAndReadAll(
    `SELECT ${UPLOAD_COLUMNS} FROM dns_queries
     WHERE ${OWN} AND seq > ? ORDER BY seq LIMIT ?`,
    [seq, limit],
  );
  return reader.getRowObjectsJS().map((row) => [
    Number(row.seq),
    row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    ...QUERY_COLUMNS.slice(1).map(([column]) => {
      const value = row[column];
      return typeof value === 'bigint' ? Number(value) : value;
    }),
  ]);
}

/** The newest seq this box has given one of its own rows, 0 with none. */
export async function ownQueriesHead() {
  const rows = await queryRaw(`SELECT max(seq) AS head FROM dns_queries WHERE ${OWN}`);
  return rows[0]?.head || 0;
}

/**
 * Store a member's rows. `accept(position)` is handed how far into this
 * member's rows the store already is (0 for a new epoch) and returns
 * { rows, position }: the rows to store, each an array of values in
 * QUERY_COLUMNS order, and the new position. The rows and the mark commit
 * together, so a batch that arrives twice is stored once. One batch at a
 * time. Resolves what accept returned.
 */
export function storeMemberQueries(instanceId, epoch, accept) {
  const run = async () => {
    if (!ingest) throw new Error('The analytics database is not open.');
    const reader = await ingest.runAndReadAll(
      'SELECT epoch, position FROM collected_marks WHERE instance_id = ?',
      [instanceId],
    );
    const mark = reader.getRowObjectsJS()[0];
    const accepted = accept(mark && mark.epoch === epoch ? Number(mark.position) : 0);
    await ingest.run('BEGIN TRANSACTION');
    try {
      // In pieces: one statement's parameters are bounded.
      for (let i = 0; i < accepted.rows.length; i += 500) {
        const piece = accepted.rows.slice(i, i + 500);
        await ingest.run(
          `INSERT INTO dns_queries (${QUERY_COLUMN_NAMES}, instance_id) VALUES ${piece
            .map(() => `(${QUERY_PLACEHOLDERS}, ?)`)
            .join(', ')}`,
          piece.flatMap((row) => [...row, instanceId]),
        );
      }
      await ingest.run('DELETE FROM collected_marks WHERE instance_id = ?', [instanceId]);
      await ingest.run(
        'INSERT INTO collected_marks (instance_id, epoch, position) VALUES (?, ?, ?)',
        [instanceId, epoch, accepted.position],
      );
      await ingest.run('COMMIT');
    } catch (err) {
      await ingest.run('ROLLBACK').catch(() => {});
      throw err;
    }
    return accepted;
  };
  const result = ingestQueue.then(run);
  ingestQueue = result.catch(() => {});
  return result;
}

// Prune old data based on retention setting. Members' rows on the controller
// go by the same rule as its own.
export function pruneOldData() {
  if (!connection) return Promise.resolve();
  const days = analyticsRetentionDays();
  const interval = rangeToInterval(`${days}d`) || `${days} DAYS`;
  return connection
    .run(`DELETE FROM dns_queries WHERE ts < NOW() - INTERVAL '${interval}'`)
    .catch((err) => console.error('[analytics] Prune error:', err.message));
}

// Flush buffer and close DuckDB
export async function closeAnalyticsDb() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  if (ingest) {
    await ingestQueue;
    try {
      ingest.closeSync();
    } catch (err) {
      console.error('[analytics] Close error:', err.message);
    }
    ingest = null;
  }
  if (connection) {
    await flushQueries();
    try {
      connection.closeSync();
    } catch (err) {
      console.error('[analytics] Close error:', err.message);
    }
    connection = null;
  }
  if (instance) {
    try {
      instance.closeSync();
    } catch (err) {
      console.error('[analytics] Instance close error:', err.message);
    }
    instance = null;
  }
}
