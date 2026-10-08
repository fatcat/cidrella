import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';

const probeAddress = vi.fn();
const testDnsForwarder = vi.fn();
vi.mock('../../../src/utils/upstream-probe.js', () => ({ probeAddress }));
vi.mock('../../../src/utils/dns-test.js', () => ({ testDnsForwarder }));

const { forwarderHealth, clearForwarderHealth } =
  await import('../../../src/utils/forwarder-health.js');

let tmpDir;
let db;
const set = (key, value) =>
  db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));

const quad9 = { hostname: 'dns10.quad9.net', addresses: ['9.9.9.10', '2620:fe::10'] };
const adguard = { hostname: 'unfiltered.adguard-dns.com', addresses: ['94.140.14.140'] };

beforeAll(async () => {
  ({ tmpDir, db } = await setupTestDb());
  enableIpv6(db);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  clearForwarderHealth();
  probeAddress.mockReset();
  testDnsForwarder.mockReset();
  set('dns_no_recursion', 'false');
  set('dns_upstream_servers', ['8.8.8.8', '2001:4860:4860::8888']);
  set('forwarder_encrypted_upstreams', [quad9, adguard]);
  set('dns_upstream_backup_servers', []);
});

describe('forwarderHealth', () => {
  it('probes the plain backup after the primary, either family', async () => {
    set('forwarder_encryption', 'off');
    set('dns_upstream_backup_servers', ['1.1.1.1', '2606:4700:4700::1111']);
    testDnsForwarder.mockResolvedValue({ reachable: true });
    const out = await forwarderHealth();
    expect(out.map((f) => f.ip)).toEqual([
      '8.8.8.8',
      '2001:4860:4860::8888',
      '1.1.1.1',
      '2606:4700:4700::1111',
    ]);
  });
  it('probes every address of every encrypted provider, either family', async () => {
    set('forwarder_encryption', 'tls');
    probeAddress.mockImplementation(async ({ address }) =>
      address === '9.9.9.10'
        ? { problem: 'DoT timeout', connected: false, ms: 3000 }
        : { problem: null, connected: true, ms: 12 },
    );
    const out = await forwarderHealth();
    expect(probeAddress).toHaveBeenCalledTimes(3);
    expect(probeAddress.mock.calls.every(([args]) => args.protocol === 'dot')).toBe(true);
    expect(testDnsForwarder).not.toHaveBeenCalled();
    expect(out).toEqual([
      {
        ip: '9.9.9.10',
        label: 'dns10.quad9.net',
        protocol: 'dot',
        reachable: false,
        latency_ms: null,
        problem: 'DoT timeout',
      },
      {
        ip: '2620:fe::10',
        label: 'dns10.quad9.net',
        protocol: 'dot',
        reachable: true,
        latency_ms: 12,
        problem: null,
      },
      {
        ip: '94.140.14.140',
        label: 'unfiltered.adguard-dns.com',
        protocol: 'dot',
        reachable: true,
        latency_ms: 12,
        problem: null,
      },
    ]);
  });

  it('probes the plain servers when encryption is off', async () => {
    set('forwarder_encryption', 'off');
    testDnsForwarder.mockImplementation(async (ip) =>
      ip === '8.8.8.8' ? { reachable: true } : { reachable: false, error: 'Timeout' },
    );
    const out = await forwarderHealth();
    expect(probeAddress).not.toHaveBeenCalled();
    expect(out.map((f) => [f.ip, f.protocol, f.reachable, f.problem])).toEqual([
      ['8.8.8.8', 'dns', true, null],
      ['2001:4860:4860::8888', 'dns', false, 'Timeout'],
    ]);
  });

  it('keeps a result for 30 seconds, and probes again when the upstreams change', async () => {
    set('forwarder_encryption', 'https');
    probeAddress.mockResolvedValue({ problem: null, connected: true, ms: 5 });
    await forwarderHealth({ now: 1_000_000 });
    await forwarderHealth({ now: 1_029_000 });
    expect(probeAddress).toHaveBeenCalledTimes(3);
    expect(probeAddress.mock.calls[0][0].protocol).toBe('doh');
    await forwarderHealth({ now: 1_031_000 });
    expect(probeAddress).toHaveBeenCalledTimes(6);
    set('forwarder_encrypted_upstreams', [adguard]);
    await forwarderHealth({ now: 1_032_000 });
    expect(probeAddress).toHaveBeenCalledTimes(7);
  });

  it('probes nothing when recursion is off', async () => {
    set('dns_no_recursion', 'true');
    expect(await forwarderHealth()).toEqual([]);
    expect(probeAddress).not.toHaveBeenCalled();
    expect(testDnsForwarder).not.toHaveBeenCalled();
  });
});
