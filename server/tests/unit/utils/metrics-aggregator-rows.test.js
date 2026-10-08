import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/utils/dns-proxy.js', () => ({
  getBlockedDelta: () => 0,
  getAndResetCountryHits: () => new Map(),
  getAndResetBlocklistHits: () => ({ delta: 0, categoryHits: new Map() }),
  getAndResetPerformanceMetrics: () => ({
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
  }),
}));

vi.mock('../../../src/utils/encrypted-forwarder.js', () => ({
  getAndResetForwarderMetrics: () => [
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
}));

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

describe('metrics aggregator: resolver rows', () => {
  it('writes failed answers by cause and each upstream address, either family', async () => {
    vi.useFakeTimers();
    try {
      startMetricsAggregator(db);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      stopMetricsAggregator();
      vi.useRealTimers();
    }
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
