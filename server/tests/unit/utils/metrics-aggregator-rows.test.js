import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

// What the next drain returns: the minute below, or the empty drain the web
// app uses when the proxy did not answer.
const drain = vi.hoisted(() => ({ proxyDown: false }));

vi.mock('../../../src/utils/dns-proxy.js', async () => {
  const { emptyMetrics } = await import('../../../src/dns-proxy/server.js');
  return {
    drainProxyMetrics: async () =>
      drain.proxyDown
        ? { ...emptyMetrics(), forwarder: [] }
        : {
            forwarder: [
              {
                provider: 'dns10.quad9.net',
                address: '9.9.9.10',
                protocol: 'dot',
                queries: 10,
                answers: 7,
                timeouts: 3,
                drops: 1,
                connect_failures: 0,
                failovers: 0,
                latency_p50_us: 12000,
                latency_p95_us: 40000,
              },
              {
                provider: 'dns10.quad9.net',
                address: '2620:fe::10',
                protocol: 'dot',
                queries: 2,
                answers: 2,
                timeouts: 0,
                drops: 0,
                connect_failures: 0,
                failovers: 0,
                latency_p50_us: 13000,
                latency_p95_us: 13000,
              },
              {
                provider: 'dns10.quad9.net',
                address: '',
                protocol: 'dot',
                queries: 0,
                answers: 0,
                timeouts: 0,
                drops: 0,
                connect_failures: 0,
                failovers: 3,
                latency_p50_us: null,
                latency_p95_us: null,
              },
            ],
            blockedDelta: 0,
            countryHits: new Map(),
            blocklistHits: { delta: 0, categoryHits: new Map() },
            performance: {
              queryCount: 12,
              latencyMin: 100,
              latencyAvg: 200,
              latencyMax: 900,
              latencyP95: 800,
              cacheHits: 4,
              cacheMisses: 8,
              timeouts: 1,
              pendingQueries: 0,
              startupMs: null,
              failures: { dnssec: 3, upstream: 2, timeout: 1, refused: 0, other: 4 },
              nxdomain: 5,
              cpuPercent: 7.5,
              rssMb: 115.3,
              heapMb: 30.1,
            },
          },
  };
});

const { startMetricsAggregator, stopMetricsAggregator } =
  await import('../../../src/utils/metrics-aggregator.js');

let tmpDir;
let db;

beforeAll(async () => {
  ({ tmpDir, db } = await setupTestDb());
});

afterAll(() => {
  stopMetricsAggregator();
  cleanupTestDb(tmpDir);
});

// One aggregator minute, into tables emptied first.
async function oneMinute() {
  db.exec('DELETE FROM metrics_proxy_perf; DELETE FROM metrics_forwarder;');
  vi.useFakeTimers();
  try {
    startMetricsAggregator(db);
    await vi.advanceTimersByTimeAsync(60_000);
  } finally {
    stopMetricsAggregator();
    vi.useRealTimers();
  }
}

const lastProcessRow = () =>
  db.prepare('SELECT cpu_percent, rss_mb, heap_mb FROM metrics_proxy_perf ORDER BY id DESC').get();

describe('metrics aggregator: the proxy process', () => {
  it("stores the proxy's own CPU and memory, not the web app's", async () => {
    drain.proxyDown = false;
    await oneMinute();
    expect(lastProcessRow()).toEqual({ cpu_percent: 7.5, rss_mb: 115.3, heap_mb: 30.1 });
  });

  it('leaves a minute the proxy did not answer empty', async () => {
    drain.proxyDown = true;
    try {
      await oneMinute();
    } finally {
      drain.proxyDown = false;
    }
    expect(lastProcessRow()).toEqual({ cpu_percent: null, rss_mb: null, heap_mb: null });
  });
});

describe('metrics aggregator: resolver rows', () => {
  it('writes failed answers by cause and each upstream address, either family', async () => {
    await oneMinute();
    const perf = db
      .prepare(
        `SELECT servfail_dnssec, servfail_upstream, servfail_timeout, servfail_refused,
                servfail_other, nxdomain, query_count FROM metrics_proxy_perf`,
      )
      .get();
    expect(perf).toEqual({
      servfail_dnssec: 3,
      servfail_upstream: 2,
      servfail_timeout: 1,
      servfail_refused: 0,
      servfail_other: 4,
      nxdomain: 5,
      query_count: 12,
    });
    const rows = db
      .prepare('SELECT address, answers, timeouts, failovers FROM metrics_forwarder ORDER BY id')
      .all();
    expect(rows).toEqual([
      { address: '9.9.9.10', answers: 7, timeouts: 3, failovers: 0 },
      { address: '2620:fe::10', answers: 2, timeouts: 0, failovers: 0 },
      { address: '', answers: 0, timeouts: 0, failovers: 3 },
    ]);
  });
});
