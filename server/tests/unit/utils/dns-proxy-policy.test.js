import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Fake backend registry before importing dns-proxy (no dnsmasq writes or restarts)
vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);

// Mock duckdb.js to avoid DuckDB dependency in unit tests
vi.mock('../../../src/db/duckdb.js', () => ({
  logDnsQuery: vi.fn(),
}));

import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { getDb } from '../../../src/db/init.js';
import {
  evaluateInboundPolicy,
  evaluateResolvedPolicy,
  loadBlocklist,
  loadAllowlist,
  loadGeoipRules,
  loadGeoipAllowlist,
  loadFilteringOverrides,
  filteringBypass,
} from '../../../src/utils/dns-proxy.js';
import { setHostFiltering } from '../../../src/models/filtering-exemption.js';

let tmpDir;

// The v0.4.16 refactor moved the filtering verdicts into these two shared
// evaluators precisely so the UDP and TCP paths cannot drift. This suite is
// the drift tripwire: it pins the verdict semantics both transports rely on.

// Fake country lookup so the geoip matrix runs without an MMDB on disk.
// 198.51.100.7 is RU but sits inside the allowlisted /24 below, so it is
// exempted before the country lookup ever runs and cannot stand in for a
// blocked country. 203.0.113.50 is the RU address that actually reaches here.
const lookup = (ip) =>
  ({
    '203.0.113.9': 'CN',
    '203.0.113.50': 'RU',
    '198.51.100.7': 'RU',
    '192.0.2.10': 'DE',
  })[ip] || null;

beforeAll(async () => {
  const result = await setupTestDb();
  tmpDir = result.tmpDir;
  const db = result.db;

  db.exec(`
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('CN', 'China', 1);
    INSERT OR IGNORE INTO geoip_rules (country_code, country_name, enabled) VALUES ('RU', 'Russia', 1);
  `);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_mode', 'blocklist')",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_enabled', 'true')",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip', '')",
  ).run();

  db.prepare(
    "INSERT INTO blocklist_categories (slug, enabled) VALUES ('malware', 1) ON CONFLICT(slug) DO UPDATE SET enabled = 1",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO blocklist_domains (domain, category_slug) VALUES ('evil.example.com', 'malware')",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO blocklist_allowlist (domain) VALUES ('trusted.example.net')",
  ).run();
  db.prepare("INSERT OR IGNORE INTO geoip_ip_allowlist (value) VALUES ('198.51.100.0/24')").run();

  loadBlocklist();
  loadAllowlist();
  loadGeoipRules();
  loadGeoipAllowlist();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('evaluateInboundPolicy (blocklist verdict, shared by UDP + TCP)', () => {
  it('blocks a listed domain with its category and NXDOMAIN semantics', () => {
    const v = evaluateInboundPolicy('evil.example.com');
    expect(v).toEqual({ action: 'block', blockReason: 'malware', responseCode: 'NXDOMAIN' });
  });

  it('logs NOERROR when either sinkhole answers, matching the reply (IPV6-27)', () => {
    const db = getDb();
    const setRedirects = (v4, v6) => {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip', ?)",
      ).run(v4);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_redirect_ip6', ?)",
      ).run(v6);
      loadBlocklist();
    };
    try {
      for (const [v4, v6, code] of [
        ['', 'fd00::1', 'NOERROR'],
        ['0.0.0.0', '', 'NOERROR'],
        ['', '', 'NXDOMAIN'],
      ]) {
        setRedirects(v4, v6);
        expect([v4, v6, evaluateInboundPolicy('evil.example.com').responseCode]).toEqual([
          v4,
          v6,
          code,
        ]);
      }
    } finally {
      setRedirects('', '');
    }
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
    const v = evaluateResolvedPolicy('some.example.com', ['203.0.113.9'], null, lookup);
    expect(v.action).toBe('block');
    expect(v.blockReason).toBe('CN');
    expect(v.countryCodes).toEqual(['CN']);
  });

  it('forwards when the country is not blocked', () => {
    expect(evaluateResolvedPolicy('some.example.com', ['192.0.2.10'], null, lookup).action).toBe(
      'forward',
    );
  });

  it('exempts allowlisted answer IPs before the country lookup', () => {
    // 198.51.100.7 is RU (blocked) but inside the allowlisted /24
    expect(evaluateResolvedPolicy('some.example.com', ['198.51.100.7'], null, lookup).action).toBe(
      'forward',
    );
  });

  it('a allowlisted query name overrides a would-be country block', () => {
    expect(
      evaluateResolvedPolicy('trusted.example.net', ['203.0.113.9'], null, lookup).action,
    ).toBe('forward');
  });

  it('one blocked-country IP among clean ones blocks, naming only the blocked country', () => {
    // DE is clean, CN is blocked, and DE is looked up first. The verdict must
    // name CN. This used to report ['DE', 'CN'] with blockReason 'DE', which
    // charged DE in the per-country hit counters and logged it as the reason
    // for a block it had nothing to do with.
    const v = evaluateResolvedPolicy(
      'some.example.com',
      ['192.0.2.10', '203.0.113.9'],
      null,
      lookup,
    );
    expect(v.action).toBe('block');
    expect(v.countryCodes).toEqual(['CN']);
    expect(v.blockReason).toBe('CN');
  });

  it('does not charge a clean country in the hit counters', () => {
    // countryCodes is what recordResolvedBlock increments, so a clean code
    // appearing here is a silently wrong analytics number, not just a log line.
    const v = evaluateResolvedPolicy(
      'some.example.com',
      ['192.0.2.10', '203.0.113.9'],
      null,
      lookup,
    );
    expect(v.countryCodes).not.toContain('DE');
  });

  it('reports two DISTINCT blocked countries, not just the first', () => {
    // CN and RU are both blocked, DE is clean. All three are looked up, so
    // this pins the property the name claims: a regression that kept only the
    // first distinct match would still return ['CN'] and pass a weaker test.
    const v = evaluateResolvedPolicy(
      'some.example.com',
      ['203.0.113.9', '192.0.2.10', '203.0.113.50'],
      null,
      lookup,
    );
    expect(v.action).toBe('block');
    expect(v.countryCodes).toEqual(['CN', 'RU']);
    expect(v.blockReason).toBe('CN');
  });

  it('keeps duplicates, because each answer is a separate hit', () => {
    // countryCodes feeds per-country counters, so two CN answers are two hits.
    const v = evaluateResolvedPolicy(
      'some.example.com',
      ['203.0.113.9', '192.0.2.10', '203.0.113.9'],
      null,
      lookup,
    );
    expect(v.countryCodes).toEqual(['CN', 'CN']);
  });

  it('forwards empty and lookup-less answer sets, with no destination', () => {
    const none = { action: 'forward', destination: null };
    expect(evaluateResolvedPolicy('some.example.com', [], null, lookup)).toEqual(none);
    expect(evaluateResolvedPolicy('some.example.com', ['10.0.0.1'], null, lookup)).toEqual(none);
  });
});

describe('the destination a verdict names (the Resolution Map)', () => {
  const places = {
    '192.0.2.10': [13.4, 52.5],
    '2001:db8::10': [2.35, 48.86],
    '203.0.113.9': [116.4, 39.9],
  };
  const v6Lookup = (ip) => ({ '2001:db8::10': 'FR' })[ip] || lookup(ip);
  const pointOf = (ip) => places[ip] || null;

  it('names the first placed answer of a forward, A and AAAA', () => {
    expect(
      evaluateResolvedPolicy('a.example', ['10.0.0.1', '192.0.2.10'], null, lookup, pointOf),
    ).toEqual({ action: 'forward', destination: { country: 'DE', point: [13.4, 52.5] } });
    expect(evaluateResolvedPolicy('a.example', ['2001:db8::10'], null, v6Lookup, pointOf)).toEqual({
      action: 'forward',
      destination: { country: 'FR', point: [2.35, 48.86] },
    });
  });

  it('names the blocking answer of a GeoIP block, not the first answer', () => {
    const v = evaluateResolvedPolicy(
      'a.example',
      ['192.0.2.10', '203.0.113.9'],
      null,
      lookup,
      pointOf,
    );
    expect([v.action, v.destination]).toEqual(['block', { country: 'CN', point: [116.4, 39.9] }]);
  });

  it('keeps a country without a city point', () => {
    expect(
      evaluateResolvedPolicy('a.example', ['203.0.113.50'], null, lookup, pointOf).destination,
    ).toEqual({ country: 'RU', point: null });
  });
});

describe('filtering overrides (a pause, and hosts with filtering off)', () => {
  const lease = (ip, mac, version = 4) =>
    getDb()
      .prepare(
        `INSERT INTO dhcp_leases (ip_address, mac_address, expires_at, dhcp_version)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ip, mac, new Date(Date.now() + 3600e3).toISOString(), version);
  const setPause = (iso) =>
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('filtering_paused_until', ?)")
      .run(iso);
  const blocked = (client) => evaluateInboundPolicy('evil.example.com', client).action === 'block';
  const geoBlocked = (client) =>
    evaluateResolvedPolicy('some.example.com', ['203.0.113.9'], client, lookup).action === 'block';

  afterEach(() => {
    vi.useRealTimers();
    getDb().exec('DELETE FROM filtering_exemptions; DELETE FROM dhcp_leases;');
    setPause('');
    loadFilteringOverrides();
  });

  it('exempts a device by MAC and follows it to its next lease, both families', () => {
    for (const [first, next, mac, version] of [
      ['10.9.0.20', '10.9.0.21', 'aa:bb:cc:00:00:01', 4],
      ['2001:db8::20', '2001:db8::21', 'aa:bb:cc:00:00:02', 6],
    ]) {
      lease(first, mac, version);
      setHostFiltering(getDb(), { ip: first }, false);
      loadFilteringOverrides();
      expect([first, blocked(first), geoBlocked(first)]).toEqual([first, false, false]);
      expect(blocked('10.9.0.99')).toBe(true);

      getDb()
        .prepare('UPDATE dhcp_leases SET ip_address = ? WHERE ip_address = ?')
        .run(next, first);
      loadFilteringOverrides();
      expect([next, blocked(next), blocked(first)]).toEqual([next, false, true]);
    }
  });

  it('exempts a host with no MAC by its address, and turning it back on clears it', () => {
    for (const ip of ['10.9.0.50', 'fd00::50']) {
      setHostFiltering(getDb(), { ip }, false);
      loadFilteringOverrides();
      expect(filteringBypass(ip)).toBe('host');
      expect(blocked(ip)).toBe(false);

      setHostFiltering(getDb(), { ip }, true);
      loadFilteringOverrides();
      expect(blocked(ip)).toBe(true);
    }
    expect(getDb().prepare('SELECT COUNT(*) FROM filtering_exemptions').pluck().get()).toBe(0);
  });

  it('turning a device back on clears an exemption stored before its MAC was known', () => {
    setHostFiltering(getDb(), { ip: '10.9.0.60' }, false);
    lease('10.9.0.60', 'aa:bb:cc:00:00:60');
    setHostFiltering(getDb(), { ip: '10.9.0.60' }, true);
    loadFilteringOverrides();
    expect(blocked('10.9.0.60')).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) FROM filtering_exemptions').pluck().get()).toBe(0);
  });

  it('a client with filtering off is never blocked but its answers keep a place', () => {
    for (const ip of ['10.9.0.70', 'fd00::70']) {
      setHostFiltering(getDb(), { ip }, false);
      loadFilteringOverrides();
      const v = evaluateResolvedPolicy('some.example.com', ['203.0.113.9'], ip, lookup);
      expect([ip, v]).toEqual([
        ip,
        { action: 'forward', destination: { country: 'CN', point: null } },
      ]);
    }
  });

  it('a pause turns both checks off for every client and ends by itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    setPause('2026-10-09T12:05:00.000Z');
    loadFilteringOverrides();
    for (const client of ['10.9.0.99', '2001:db8::99', null]) {
      expect([client, blocked(client), geoBlocked(client)]).toEqual([client, false, false]);
    }
    vi.setSystemTime(new Date('2026-10-09T12:05:00Z'));
    expect(blocked('10.9.0.99')).toBe(true);
    expect(geoBlocked('2001:db8::99')).toBe(true);
  });
});
