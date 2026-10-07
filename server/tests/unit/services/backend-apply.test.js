/**
 * applyDhcp sequences CIDRella's DHCP name sync around the backend: after the
 * scope files are written (so a failed write leaves the records alone) and
 * before the backend takes them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

const calls = [];
// `current` fills DNS and RA, and DHCP unless `dhcpRole` is set.
const fake = { current: null, dhcpService: null, dhcpRole: null };
vi.mock('../../../src/backends/index.js', () => ({
  getDnsBackend: () => fake.current.dns,
  getDhcpBackend: () => (fake.dhcpRole || fake.current).dhcp,
  getService: (role) => (role === 'dhcp' && fake.dhcpRole) || fake.current,
  getRaBackend: () => fake.current,
  uniqueServices: () => [fake.current, fake.dhcpService].filter(Boolean),
}));
vi.mock('../../../src/models/dhcp-lease.js', async (importOriginal) => ({
  ...(await importOriginal()),
  syncDhcpDnsRecords: vi.fn(() => calls.push('sync')),
}));

const { createFakeBackend } = await import('../../helpers/fake-backends.js');
const { applyAtBoot, applyDhcp, HOOK_HANDLERS } =
  await import('../../../src/services/backend-apply.js');

let db;
let tmpDir;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  calls.length = 0;
  const backend = createFakeBackend();
  const applyScopes = backend.dhcp.applyScopes;
  backend.dhcp.applyScopes = (d, opts) => {
    calls.push(`applyScopes activate=${opts?.activate}`);
    return { ...applyScopes(d, opts), activation: 'restart' };
  };
  backend.applyActivation = (activation) => calls.push(`activate ${activation}`);
  fake.current = backend;
  fake.dhcpService = null;
  fake.dhcpRole = null;
});

describe('applyDhcp', () => {
  it('writes the scopes, syncs the DHCP names, then activates', () => {
    applyDhcp(db);
    expect(calls).toEqual(['applyScopes activate=false', 'sync', 'activate restart']);
  });

  it('has the RA backend render the DHCPv6 scopes when another backend serves DHCP', () => {
    const kea = createFakeBackend({ name: 'kea' });
    kea.dhcp.applyScopes = () => {
      calls.push('kea applyScopes');
      return { changed: true, activation: 'reload', activated: false };
    };
    kea.applyActivation = (activation) => calls.push(`kea activate ${activation}`);
    fake.current.ra.applyRouterAdvertisements = (d, opts) => {
      calls.push(`ra activate=${opts?.activate}`);
      return { changed: true, activation: 'restart', activated: false };
    };
    fake.dhcpRole = kea;
    applyDhcp(db);
    expect(calls).toEqual([
      'kea applyScopes',
      'ra activate=false',
      'sync',
      'kea activate reload',
      'activate restart',
    ]);
  });

  it('leaves the names and the running backend alone when the write fails', () => {
    fake.current.dhcp.applyScopes = () => {
      throw new Error('dnsmasq configuration validation failed: bad line');
    };
    expect(() => applyDhcp(db)).toThrow('validation failed');
    expect(calls).toEqual([]);
  });
});

describe('applyAtBoot', () => {
  const recordActivate = (service) => {
    service.activate = vi.fn(({ force }) => (force ? 'restarted' : 'unchanged'));
    return service;
  };

  it('forces the DNS service when its config changed, and only checks the others', () => {
    recordActivate(fake.current);
    fake.dhcpService = recordActivate(createFakeBackend({ name: 'kea' }));
    expect(applyAtBoot(db, { preflight: false })).toEqual({ fake: 'restarted', kea: 'unchanged' });
    expect(fake.current.activate).toHaveBeenCalledWith({ force: true });
    expect(fake.dhcpService.activate).toHaveBeenCalledWith({ force: false });
    // Nothing changed the second time.
    expect(applyAtBoot(db, { preflight: false })).toEqual({ fake: 'unchanged', kea: 'unchanged' });
  });

  it('renders but starts or restarts nothing in an update preflight', () => {
    recordActivate(fake.current);
    fake.dhcpService = recordActivate(createFakeBackend({ name: 'kea' }));
    expect(applyAtBoot(db, { preflight: true })).toEqual({ fake: 'skipped', kea: 'skipped' });
    expect(fake.current.activate).not.toHaveBeenCalled();
    expect(fake.dhcpService.activate).not.toHaveBeenCalled();
  });

  it('reads the preflight flag from CIDRELLA_PREFLIGHT', () => {
    recordActivate(fake.current);
    vi.stubEnv('CIDRELLA_PREFLIGHT', '1');
    try {
      expect(applyAtBoot(db)).toEqual({ fake: 'skipped' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('HOOK_HANDLERS', () => {
  it('keeps the stored hook names', () => {
    expect(Object.keys(HOOK_HANDLERS)).toEqual([
      'regenerate_dns',
      'regenerate_dhcp',
      'regenerate_dnsmasq_conf',
    ]);
  });
});
