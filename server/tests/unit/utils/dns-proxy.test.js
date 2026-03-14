import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock dnsmasq.js before importing dns-proxy (avoids circular dep issues)
vi.mock('../../../src/utils/dnsmasq.js', () => ({
  regenerateDnsmasqConf: vi.fn(),
  signalDnsmasq: vi.fn(),
}));

import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  lookupCountry, getProxyStatus, resetStats, isProxyBypassed,
  getBlockedDelta, getAndResetCountryHits, getAndResetPerformanceMetrics,
} from '../../../src/utils/dns-proxy.js';

let tmpDir;

beforeAll(async () => {
  const result = await setupTestDb();
  tmpDir = result.tmpDir;
  const db = result.db;

  // Seed GeoIP rules for shouldBlock tests
  db.exec(`
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('CN', 'China', 1);
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('RU', 'Russia', 1);
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('US', 'United States', 0);
  `);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_mode', 'blocklist')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_enabled', 'false')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_proxy_port', '5353')").run();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// ── getProxyStatus ──────────────────────────────────────────────

describe('getProxyStatus', () => {
  it('returns expected shape', () => {
    const status = getProxyStatus();
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('bypassed');
    expect(status).toHaveProperty('port');
    expect(status).toHaveProperty('dbLoaded');
    expect(status).toHaveProperty('dbExists');
    expect(status).toHaveProperty('dbPath');
    expect(status).toHaveProperty('dbLastUpdated');
    expect(status).toHaveProperty('statsTotal');
    expect(status).toHaveProperty('statsBlocked');
    expect(status).toHaveProperty('statsAllowed');
  });

  it('reports not running when proxy has not been started', () => {
    const status = getProxyStatus();
    expect(status.running).toBe(false);
    expect(status.bypassed).toBe(false);
  });
});

// ── isProxyBypassed ─────────────────────────────────────────────

describe('isProxyBypassed', () => {
  it('returns false by default', () => {
    expect(isProxyBypassed()).toBe(false);
  });
});

// ── resetStats ──────────────────────────────────────────────────

describe('resetStats', () => {
  it('resets all stat counters to zero', () => {
    resetStats();
    const status = getProxyStatus();
    expect(status.statsTotal).toBe(0);
    expect(status.statsBlocked).toBe(0);
    expect(status.statsAllowed).toBe(0);
  });
});

// ── lookupCountry ───────────────────────────────────────────────

describe('lookupCountry', () => {
  it('returns null when MMDB is not loaded', () => {
    // MMDB is not loaded in tests
    expect(lookupCountry('8.8.8.8')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(lookupCountry('not-an-ip')).toBeNull();
  });
});

// ── getBlockedDelta ─────────────────────────────────────────────

describe('getBlockedDelta', () => {
  it('returns 0 when no blocks have occurred', () => {
    expect(getBlockedDelta()).toBe(0);
  });

  it('resets to 0 after read (drain semantics)', () => {
    // First read clears it
    getBlockedDelta();
    // Second read should also be 0
    expect(getBlockedDelta()).toBe(0);
  });
});

// ── getAndResetCountryHits ──────────────────────────────────────

describe('getAndResetCountryHits', () => {
  it('returns empty map when no hits', () => {
    const hits = getAndResetCountryHits();
    expect(hits).toBeInstanceOf(Map);
    expect(hits.size).toBe(0);
  });

  it('resets after read (drain semantics)', () => {
    getAndResetCountryHits();
    const hits = getAndResetCountryHits();
    expect(hits.size).toBe(0);
  });
});

// ── getAndResetPerformanceMetrics ───────────────────────────────

describe('getAndResetPerformanceMetrics', () => {
  it('returns zeroed metrics when no queries have been processed', () => {
    const m = getAndResetPerformanceMetrics();
    expect(m.queryCount).toBe(0);
    expect(m.latencyMin).toBeNull();
    expect(m.latencyAvg).toBeNull();
    expect(m.latencyMax).toBeNull();
    expect(m.latencyP95).toBeNull();
    expect(m.cacheHits).toBe(0);
    expect(m.cacheMisses).toBe(0);
    expect(m.timeouts).toBe(0);
    expect(m.pendingQueries).toBe(0);
  });

  it('resets counters after read (drain semantics)', () => {
    // First call drains
    getAndResetPerformanceMetrics();
    // Second call should be zeroed
    const m = getAndResetPerformanceMetrics();
    expect(m.queryCount).toBe(0);
    expect(m.cacheHits).toBe(0);
    expect(m.cacheMisses).toBe(0);
    expect(m.timeouts).toBe(0);
  });

  it('returns expected metric shape', () => {
    const m = getAndResetPerformanceMetrics();
    expect(m).toHaveProperty('queryCount');
    expect(m).toHaveProperty('latencyMin');
    expect(m).toHaveProperty('latencyAvg');
    expect(m).toHaveProperty('latencyMax');
    expect(m).toHaveProperty('latencyP95');
    expect(m).toHaveProperty('cacheHits');
    expect(m).toHaveProperty('cacheMisses');
    expect(m).toHaveProperty('timeouts');
    expect(m).toHaveProperty('pendingQueries');
    expect(m).toHaveProperty('startupMs');
  });
});
