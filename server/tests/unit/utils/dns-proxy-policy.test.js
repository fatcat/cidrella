import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock dnsmasq.js before importing dns-proxy (avoids circular dep issues)
vi.mock('../../../src/utils/dnsmasq.js', () => ({
  applyInterfaceConfig: vi.fn(),
  restartDnsmasq: vi.fn(),
}));

// Mock duckdb.js to avoid DuckDB dependency in unit tests
vi.mock('../../../src/db/duckdb.js', () => ({
  logDnsQuery: vi.fn(),
}));

import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  evaluateInboundPolicy, evaluateResolvedPolicy,
  loadBlocklist, loadWhitelist, loadGeoipRules, loadGeoipAllowlist,
} from '../../../src/utils/dns-proxy.js';

let tmpDir;

// The v0.4.16 refactor moved the filtering verdicts into these two shared
// evaluators precisely so the UDP and TCP paths cannot drift. This suite is
// the drift tripwire: it pins the verdict semantics both transports rely on.

// Fake country lookup so the geoip matrix runs without an MMDB on disk.
const lookup = (ip) => ({ '203.0.113.9': 'CN', '198.51.100.7': 'RU', '192.0.2.10': 'DE' }[ip] || null);

beforeAll(async () => {
  const result = await setupTestDb();
  tmpDir = result.tmpDir;
  const db = result.db;

  db.exec(`
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('CN', 'China', 1);
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('RU', 'Russia', 1);
  `);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_mode', 'blocklist')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_enabled', 'true')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip', '')").run();

  db.prepare("INSERT INTO blocklist_categories (slug, enabled) VALUES ('malware', 1) ON CONFLICT(slug) DO UPDATE SET enabled = 1").run();
  db.prepare("INSERT OR IGNORE INTO blocklist_domains (domain, category_slug) VALUES ('evil.example.com', 'malware')").run();
  db.prepare("INSERT OR IGNORE INTO blocklist_whitelist (domain) VALUES ('trusted.example.net')").run();
  db.prepare("INSERT OR IGNORE INTO geoip_ip_allowlist (value) VALUES ('198.51.100.0/24')").run();

  loadBlocklist();
  loadWhitelist();
  loadGeoipRules();
  loadGeoipAllowlist();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('evaluateInboundPolicy (blocklist verdict, shared by UDP + TCP)', () => {
  it('blocks a listed domain with its category and NXDOMAIN semantics', () => {
    const v = evaluateInboundPolicy('evil.example.com');
    expect(v).toEqual({ action: 'block', blockReason: 'malware', responseCode: 'NXDOMAIN' });
  });

  it('blocks subdomains of a listed domain', () => {
    expect(evaluateInboundPolicy('cdn.evil.example.com').action).toBe('block');
  });

  it('forwards unlisted names, empty and missing names', () => {
    expect(evaluateInboundPolicy('good.example.org')).toEqual({ action: 'forward' });
    expect(evaluateInboundPolicy('')).toEqual({ action: 'forward' });
    expect(evaluateInboundPolicy(undefined)).toEqual({ action: 'forward' });
  });
});

describe('evaluateResolvedPolicy (GeoIP verdict, shared by UDP + TCP)', () => {
  it('blocks when a resolved IP is in a blocked country', () => {
    const v = evaluateResolvedPolicy('some.example.com', ['203.0.113.9'], lookup);
    expect(v.action).toBe('block');
    expect(v.blockReason).toBe('CN');
    expect(v.countryCodes).toEqual(['CN']);
  });

  it('forwards when the country is not blocked', () => {
    expect(evaluateResolvedPolicy('some.example.com', ['192.0.2.10'], lookup).action).toBe('forward');
  });

  it('exempts allowlisted answer IPs before the country lookup', () => {
    // 198.51.100.7 is RU (blocked) but inside the allowlisted /24
    expect(evaluateResolvedPolicy('some.example.com', ['198.51.100.7'], lookup).action).toBe('forward');
  });

  it('a whitelisted query name overrides a would-be country block', () => {
    expect(evaluateResolvedPolicy('trusted.example.net', ['203.0.113.9'], lookup).action).toBe('forward');
  });

  it('one blocked-country IP among clean ones still blocks, and all codes are counted', () => {
    const v = evaluateResolvedPolicy('some.example.com', ['192.0.2.10', '203.0.113.9'], lookup);
    expect(v.action).toBe('block');
    // Faithful to the pre-refactor behavior on both transports: countryCodes
    // carries every looked-up code (clean DE included), so hit counting and
    // the logged blockReason (first code) can name a non-blocked country
    // when a mixed answer set trips the block. Flagged in REVIEW.md.
    expect(v.countryCodes).toEqual(['DE', 'CN']);
    expect(v.blockReason).toBe('DE');
  });

  it('forwards empty and lookup-less answer sets', () => {
    expect(evaluateResolvedPolicy('some.example.com', [], lookup)).toEqual({ action: 'forward' });
    expect(evaluateResolvedPolicy('some.example.com', ['10.0.0.1'], lookup)).toEqual({ action: 'forward' });
  });
});
