import path from 'path';
import duckdb from 'duckdb';
import { DATA_DIR, ANALYTICS_FLUSH_INTERVAL_MS, ANALYTICS_RETENTION_CLEANUP_MS } from '../config/defaults.js';
import { getSetting } from './init.js';

let db = null;
let buffer = [];
let flushTimer = null;
let pruneTimer = null;

// Initialize DuckDB analytics database
export function initAnalyticsDb(dataDir) {
  const dbPath = path.join(dataDir || DATA_DIR, 'analytics.duckdb');

  return new Promise((resolve, reject) => {
    db = new duckdb.Database(dbPath, (err) => {
      if (err) return reject(err);

      db.run(`
        CREATE TABLE IF NOT EXISTS dns_queries (
          ts TIMESTAMP NOT NULL,
          client_ip VARCHAR NOT NULL,
          domain VARCHAR NOT NULL,
          query_type VARCHAR NOT NULL,
          response_code VARCHAR,
          action VARCHAR NOT NULL,
          block_reason VARCHAR,
          latency_us INTEGER,
          resolved_ip VARCHAR
        )
      `, (err) => {
        if (err) return reject(err);

        // Start periodic flush
        flushTimer = setInterval(() => flushQueries(), ANALYTICS_FLUSH_INTERVAL_MS);

        // Start periodic pruning
        pruneTimer = setInterval(() => pruneOldData(), ANALYTICS_RETENTION_CLEANUP_MS);

        console.log('[analytics] DuckDB initialized', { path: dbPath });
        resolve();
      });
    });
  });
}

// Buffer a DNS query for batch insert
export function logDnsQuery({ clientIp, domain, queryType, responseCode, action, blockReason, latencyUs, resolvedIp }) {
  if (!db) return;
  buffer.push({
    ts: new Date().toISOString(),
    clientIp: clientIp || '',
    domain: domain || '',
    queryType: queryType || 'A',
    responseCode: responseCode || null,
    action: action || 'allowed',
    blockReason: blockReason || null,
    latencyUs: latencyUs != null ? Math.round(latencyUs) : null,
    resolvedIp: resolvedIp || null,
  });
}

// Flush buffered queries to DuckDB using batched multi-row INSERT
export function flushQueries() {
  if (!db || buffer.length === 0) return;

  const rows = buffer.splice(0, buffer.length);

  // Build a single INSERT with multiple value tuples and a flat params array
  const placeholders = [];
  const params = [];
  for (const row of rows) {
    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)');
    params.push(row.ts, row.clientIp, row.domain, row.queryType, row.responseCode, row.action, row.blockReason, row.latencyUs, row.resolvedIp);
  }

  const sql = `INSERT INTO dns_queries (ts, client_ip, domain, query_type, response_code, action, block_reason, latency_us, resolved_ip) VALUES ${placeholders.join(', ')}`;

  return new Promise((resolve) => {
    db.run(sql, ...params, (err) => {
      if (err) console.error('[analytics] Flush error:', err.message);
      resolve();
    });
  });
}

// Validated range-to-interval mapping — only allows known safe values
const VALID_INTERVALS = new Map();
for (const n of [1, 5, 10, 15, 30, 60]) VALID_INTERVALS.set(`${n}m`, `${n} MINUTES`);
for (const n of [1, 2, 4, 6, 12, 24, 48, 72]) VALID_INTERVALS.set(`${n}h`, `${n} HOURS`);
for (const n of [1, 2, 3, 7, 14, 30, 90]) VALID_INTERVALS.set(`${n}d`, `${n} DAYS`);

function rangeToInterval(range) {
  return VALID_INTERVALS.get(range || '24h') || '24 HOURS';
}

// Helper to run a DuckDB query and return rows
// Converts BigInt values to Number for JSON serialization
export function queryRaw(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    db.all(sql, ...params, (err, rows) => {
      if (err) return reject(err);
      const safe = (rows || []).map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return out;
      });
      resolve(safe);
    });
  });
}

// Top clients by query count
export function queryTopClients(range, limit = 20) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT client_ip, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
     GROUP BY client_ip
     ORDER BY count DESC
     LIMIT ?`,
    [limit]
  );
}

// Top queried domains
export function queryTopDomains(range, limit = 20) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
     GROUP BY domain
     ORDER BY count DESC
     LIMIT ?`,
    [limit]
  );
}

// Top clients by query count, optionally filtered by action
export function queryTopClientsByAction(range, action, limit = 10) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT client_ip, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?
     GROUP BY client_ip
     ORDER BY count DESC
     LIMIT ?`,
    [action, limit]
  );
}

// Top domains by query count, optionally filtered by action
export function queryTopDomainsByAction(range, action, limit = 10) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?
     GROUP BY domain
     ORDER BY count DESC
     LIMIT ?`,
    [action, limit]
  );
}

// Top block reasons (category slugs or country codes) for a given action
export function queryTopBlockReasons(range, action, limit = 10) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT block_reason, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action = ?
       AND block_reason IS NOT NULL
     GROUP BY block_reason
     ORDER BY count DESC
     LIMIT ?`,
    [action, limit]
  );
}

// Top blocked domains
export function queryTopBlocked(range, limit = 20) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, action, block_reason, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND action != 'allowed'
     GROUP BY domain, action, block_reason
     ORDER BY count DESC
     LIMIT ?`,
    [limit]
  );
}

// Query volume over time (bucketed)
export function queryVolume(range, interval = '5m') {
  const rangeInterval = rangeToInterval(range);
  const bucketInterval = rangeToInterval(interval);
  return queryRaw(
    `SELECT time_bucket(INTERVAL '${bucketInterval}', ts) as bucket,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE action = 'allowed') as allowed,
            COUNT(*) FILTER (WHERE action != 'allowed') as blocked
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${rangeInterval}'
     GROUP BY bucket
     ORDER BY bucket`
  );
}

// Action breakdown (counts per action type)
export function queryActionBreakdown(range) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT action, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
     GROUP BY action
     ORDER BY count DESC`
  );
}

// Domains queried by a specific client
export function queryClientDomains(clientIp, range, limit = 50) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT domain, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND client_ip = ?
     GROUP BY domain
     ORDER BY count DESC
     LIMIT ?`,
    [clientIp, limit]
  );
}

// Clients that queried a specific domain
export function queryDomainClients(domain, range, limit = 50) {
  const interval = rangeToInterval(range);
  return queryRaw(
    `SELECT client_ip, COUNT(*) as count
     FROM dns_queries
     WHERE ts >= NOW() - INTERVAL '${interval}'
       AND domain = ?
     GROUP BY client_ip
     ORDER BY count DESC
     LIMIT ?`,
    [domain, limit]
  );
}

// Prune old data based on retention setting
export function pruneOldData() {
  if (!db) return Promise.resolve();
  const days = Math.max(1, Math.min(365, parseInt(getSetting('analytics_retention_days'), 10) || 7));
  const interval = rangeToInterval(`${days}d`) || `${days} DAYS`;
  return new Promise((resolve) => {
    db.run(
      `DELETE FROM dns_queries WHERE ts < NOW() - INTERVAL '${interval}'`,
      (err) => {
        if (err) console.error('[analytics] Prune error:', err.message);
        resolve();
      }
    );
  });
}

// Flush buffer and close DuckDB
export async function closeAnalyticsDb() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }

  if (db) {
    await flushQueries();
    return new Promise((resolve) => {
      db.close((err) => {
        if (err) console.error('[analytics] Close error:', err.message);
        db = null;
        resolve();
      });
    });
  }
}
