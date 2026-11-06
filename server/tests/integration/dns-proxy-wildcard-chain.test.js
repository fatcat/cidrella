/**
 * Whether the forwarder splits a wildcard chain follows the DNS backend,
 * through the web app's config, so a stack switch changes it with no restart.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import dnsPacket from 'dns-packet';
// The proxy under test runs in this process.
vi.mock('../../src/utils/dns-proxy-client.js', async () =>
  (await import('../helpers/proxy-in-process.js')).inProcessProxyClient(),
);
vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { backend } = await import('../../src/backends/index.js');
const { refreshProxyConfig, proxyConfigNow } = await import('../../src/utils/dns-proxy.js');
const { answerForBackend, setSplitWildcardChains } =
  await import('../../src/dns-proxy/forwarder.js');

const chain = dnsPacket.encode({
  id: 7,
  type: 'response',
  flags: dnsPacket.RECURSION_AVAILABLE,
  questions: [{ type: 'A', name: 'www.nasa.gov' }],
  answers: [
    { type: 'CNAME', name: 'www.nasa.gov', ttl: 300, data: 'nasa-gov.go-vip.net' },
    { type: 'A', name: 'nasa-gov.go-vip.net', ttl: 300, data: '192.0.66.108' },
    {
      type: 'RRSIG',
      name: 'nasa-gov.go-vip.net',
      ttl: 300,
      data: {
        typeCovered: 'A',
        algorithm: 13,
        labels: 2,
        originalTTL: 300,
        expiration: 1800000000,
        inception: 1790000000,
        keyTag: 41562,
        signersName: 'go-vip.net',
        signature: Buffer.alloc(32, 7),
      },
    },
  ],
});

let tmpDir;
beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
});
afterEach(() => {
  setSplitWildcardChains(false);
  delete backend.dns.splitWildcardChains;
});
afterAll(() => cleanupTestDb(tmpDir));

describe('the forwarder and the DNS backend', () => {
  it('splits for a backend that asks', () => {
    backend.dns.splitWildcardChains = true;
    refreshProxyConfig();
    expect(proxyConfigNow().splitWildcardChains).toBe(true);
    expect(dnsPacket.decode(answerForBackend(chain)).answers).toHaveLength(1);
  });

  it('hands the whole chain to a backend that does not', () => {
    backend.dns.splitWildcardChains = false;
    refreshProxyConfig();
    expect(answerForBackend(chain)).toBe(chain);
  });

  it('follows a change of backend', () => {
    backend.dns.splitWildcardChains = true;
    refreshProxyConfig();
    backend.dns.splitWildcardChains = false;
    refreshProxyConfig();
    expect(answerForBackend(chain)).toBe(chain);
    backend.dns.splitWildcardChains = true;
    refreshProxyConfig();
    expect(answerForBackend(chain)).not.toBe(chain);
  });

  it('hands the whole chain over before any config arrives', () => {
    expect(answerForBackend(chain)).toBe(chain);
  });
});
