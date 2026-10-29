/**
 * An interface change on a stack whose DHCP server is not its DNS server
 * (PowerDNS + Kea) re-renders DHCP too: Kea and radvd take their interfaces
 * with their scopes, not with the DNS listen file. On dnsmasq, one daemon,
 * the listen write covers both and nothing more is queued.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execSync: vi.fn(), execFile: vi.fn() }));
vi.mock('../../../src/utils/dns-proxy.js', () => ({ rebindProxy: vi.fn() }));
vi.mock('../../../src/utils/after-commit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  queueRegen: vi.fn(),
}));
vi.mock('../../../src/backends/index.js', async () => {
  const { fakeBackendsModule, createFakeBackend } = await import('../../helpers/fake-backends.js');
  const mod = fakeBackendsModule({ name: 'pdns' });
  const kea = createFakeBackend({ name: 'kea' });
  const split = { value: false };
  return {
    ...mod,
    kea,
    split,
    getService: (role) => (split.value && role !== 'dns' ? kea : mod.backend),
  };
});

const { default: request } = await import('supertest');
const { queueRegen } = await import('../../../src/utils/after-commit.js');
const { rebindProxy } = await import('../../../src/utils/dns-proxy.js');
const backends = await import('../../../src/backends/index.js');

let tmpDir;
let app;
beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  const interfaces = await import('../../../src/routes/interfaces.js');
  app = createMultiRouterApp([{ prefix: '/api/interfaces', router: interfaces.default }]);
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => queueRegen.mockClear());

describe('PUT /api/interfaces/config and the DHCP server', () => {
  it('queues a DHCP render when DHCP has its own server', async () => {
    backends.split.value = true;
    const res = await request(app)
      .put('/api/interfaces/config')
      .send({ interfaces: { eth0: { dns: true, dhcp: true } } });
    expect(res.status).toBe(200);
    expect(queueRegen).toHaveBeenCalledWith('regenerate_dhcp');
  });

  it('queues nothing extra when one daemon serves both', async () => {
    backends.split.value = false;
    const res = await request(app)
      .put('/api/interfaces/config')
      .send({ interfaces: { eth0: { dns: true, dhcp: false } } });
    expect(res.status).toBe(200);
    expect(queueRegen).not.toHaveBeenCalledWith('regenerate_dhcp');
  });

  it('queues nothing when only a web setting changes', async () => {
    backends.split.value = true;
    const res = await request(app)
      .put('/api/interfaces/config')
      .send({ http_redirect_enabled: true });
    expect(res.status).toBe(200);
    expect(queueRegen).not.toHaveBeenCalledWith('regenerate_dhcp');
  });
});

describe('PUT /api/interfaces/config and the DNS restart', () => {
  it('waits for the restart before it rebinds the proxy and answers', async () => {
    backends.split.value = false;
    const order = [];
    const activate = vi.spyOn(backends.backend, 'activate').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            order.push('restarted');
            resolve('restarted');
          }, 50),
        ),
    );
    rebindProxy.mockImplementation(() => order.push('rebind'));
    try {
      const res = await request(app)
        .put('/api/interfaces/config')
        .send({ interfaces: { eth0: { dns: true, dhcp: true } } });
      expect(res.status).toBe(200);
      expect(res.body.dnsmasq).toBe('restarted');
      expect(order).toEqual(['restarted', 'rebind']);
    } finally {
      activate.mockRestore();
      rebindProxy.mockReset();
    }
  });
});
