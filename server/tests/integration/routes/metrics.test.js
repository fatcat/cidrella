import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// Mock dns-proxy so we control getProxyStatus return values
vi.mock('../../../src/utils/dns-proxy.js', () => ({
  getProxyStatus: vi.fn(() => ({
    running: true,
    bypassed: false,
    port: 53,
    listenAddresses: ['192.168.1.1'],
    dbLoaded: true,
    dbExists: true,
    dbPath: '/data/geoip/dbip-country-lite.mmdb',
    dbLastUpdated: '2026-03-01T00:00:00.000Z',
    statsTotal: 1000,
    statsBlocked: 42,
    statsAllowed: 958,
    blocklistLoaded: true,
    blocklistDomainCount: 741000,
  })),
}));

// Import after mocks
const { default: metricsRouter } = await import('../../../src/routes/metrics.js');
const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(metricsRouter, '/api/metrics');

  // Seed upstream servers for the services endpoint
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dns_upstream_servers', ?)")
    .run(JSON.stringify(['8.8.8.8']));

  // Seed some metrics data
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO metrics (ts, dns_queries, dhcp_requests, blocklist_blocks, geoip_blocks) VALUES (?, ?, ?, ?, ?)')
    .run(ts, 100, 5, 3, 1);
  db.prepare('INSERT INTO metrics_blocklist_hits (ts, category, count) VALUES (?, ?, ?)')
    .run(ts, 'malware', 3);
  db.prepare('INSERT INTO metrics_geoip_hits (ts, country, count) VALUES (?, ?, ?)')
    .run(ts, 'CN', 1);
  db.prepare(`INSERT INTO metrics_proxy_perf
    (ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
     cache_hits, cache_misses, timeouts, pending_queries,
     cpu_percent, rss_mb, heap_mb, startup_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, 50, 120, 450, 2200, 1800, 40, 10, 0, 2, 1.5, 45.2, 22.1, 85);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// ── GET /api/metrics/timeseries ─────────────────────────────────

describe('GET /api/metrics/timeseries', () => {
  it('returns timeseries data', async () => {
    const res = await request(app).get('/api/metrics/timeseries?range=24h');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('ts');
    expect(res.body[0]).toHaveProperty('dns_queries');
    expect(res.body[0]).toHaveProperty('dhcp_requests');
    expect(res.body[0]).toHaveProperty('blocklist_blocks');
    expect(res.body[0]).toHaveProperty('geoip_blocks');
  });

  it('defaults to 24h range', async () => {
    const res = await request(app).get('/api/metrics/timeseries');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── GET /api/metrics/blocklist-hits ─────────────────────────────

describe('GET /api/metrics/blocklist-hits', () => {
  it('returns blocklist hit data grouped by category', async () => {
    const res = await request(app).get('/api/metrics/blocklist-hits?range=24h');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('category');
    expect(res.body[0]).toHaveProperty('count');
    expect(res.body[0].category).toBe('malware');
  });
});

// ── GET /api/metrics/geoip-hits ─────────────────────────────────

describe('GET /api/metrics/geoip-hits', () => {
  it('returns geoip hit data grouped by country', async () => {
    const res = await request(app).get('/api/metrics/geoip-hits?range=24h');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('country');
    expect(res.body[0]).toHaveProperty('count');
    expect(res.body[0].country).toBe('CN');
  });
});

// ── GET /api/metrics/proxy-perf ─────────────────────────────────

describe('GET /api/metrics/proxy-perf', () => {
  it('returns proxy performance data', async () => {
    const res = await request(app).get('/api/metrics/proxy-perf?range=24h');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const row = res.body[0];
    expect(row).toHaveProperty('ts');
    expect(row).toHaveProperty('query_count');
    expect(row).toHaveProperty('latency_min');
    expect(row).toHaveProperty('latency_avg');
    expect(row).toHaveProperty('latency_max');
    expect(row).toHaveProperty('latency_p95');
    expect(row).toHaveProperty('cache_hits');
    expect(row).toHaveProperty('cache_misses');
    expect(row).toHaveProperty('timeouts');
    expect(row).toHaveProperty('pending_queries');
    expect(row).toHaveProperty('cpu_percent');
    expect(row).toHaveProperty('rss_mb');
    expect(row).toHaveProperty('heap_mb');
    expect(row).toHaveProperty('startup_ms');
  });

  it('returns correct values', async () => {
    const res = await request(app).get('/api/metrics/proxy-perf?range=24h');
    const row = res.body[0];
    expect(row.query_count).toBe(50);
    expect(row.latency_avg).toBe(450);
    expect(row.cache_hits).toBe(40);
    expect(row.cache_misses).toBe(10);
    expect(row.startup_ms).toBe(85);
  });
});

// ── GET /api/metrics/services ───────────────────────────────────

describe('GET /api/metrics/services', () => {
  it('returns service status including proxy fields', async () => {
    const res = await request(app).get('/api/metrics/services');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dnsmasq');
    expect(res.body).toHaveProperty('geoip_proxy');
    expect(res.body).toHaveProperty('geoip_bypassed');
    expect(res.body).toHaveProperty('geoip_port');
    expect(res.body).toHaveProperty('geoip_db_loaded');
    expect(res.body).toHaveProperty('geoip_db_last_updated');
    expect(res.body).toHaveProperty('geoip_stats_total');
    expect(res.body).toHaveProperty('geoip_stats_blocked');
    expect(res.body).toHaveProperty('geoip_stats_allowed');
    expect(res.body).toHaveProperty('forwarders');
  });

  it('returns mocked proxy status values', async () => {
    const res = await request(app).get('/api/metrics/services');
    expect(res.body.geoip_proxy).toBe(true);
    expect(res.body.geoip_bypassed).toBe(false);
    expect(res.body.geoip_port).toBe(53);
    expect(res.body.geoip_stats_total).toBe(1000);
    expect(res.body.geoip_stats_blocked).toBe(42);
  });
});
