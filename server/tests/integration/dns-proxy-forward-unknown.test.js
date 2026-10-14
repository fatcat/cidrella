/**
 * Which answers the DNS proxy asks the forwarder for again: an NXDOMAIN for a
 * name under a forward-unknown zone, only when the DNS backend does not
 * forward those names itself (PowerDNS), and never with recursion off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { backend } = await import('../../src/backends/index.js');
const { setSetting } = await import('../../src/db/init.js');
const { wantsUnknownRetry } = await import('../../src/utils/dns-proxy.js');

let tmpDir;
let db;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  db.prepare(
    "INSERT INTO dns_zones (name, type, enabled, forward_unknown) VALUES ('corp.example', 'forward', 1, 1), ('home.test', 'forward', 1, 0)",
  ).run();
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => {
  backend.dns.forwardsUnknownItself = false;
  setSetting('dns_no_recursion', 'false');
});

const nx = { rcode: 'NXDOMAIN' };

describe('wantsUnknownRetry', () => {
  it('retries an NXDOMAIN under a forward-unknown zone on PowerDNS', () => {
    expect(wantsUnknownRetry(nx, 'vpn.corp.example')).toBe(true);
    expect(wantsUnknownRetry(nx, 'CORP.EXAMPLE.')).toBe(true);
  });

  it('leaves every other answer alone', () => {
    expect(wantsUnknownRetry({ rcode: 'NOERROR' }, 'vpn.corp.example')).toBe(false);
    expect(wantsUnknownRetry(nx, 'printer.home.test')).toBe(false);
    expect(wantsUnknownRetry(nx, 'notcorp.example')).toBe(false);
    expect(wantsUnknownRetry(null, 'vpn.corp.example')).toBe(false);
  });

  it('never retries on dnsmasq, which forwards those names itself', () => {
    backend.dns.forwardsUnknownItself = true;
    expect(wantsUnknownRetry(nx, 'vpn.corp.example')).toBe(false);
  });

  it('never retries with recursion off', () => {
    setSetting('dns_no_recursion', 'true');
    expect(wantsUnknownRetry(nx, 'vpn.corp.example')).toBe(false);
  });
});
