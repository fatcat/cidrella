/**
 * A zone answers every name under it unless it opts out (forward_unknown),
 * for a split-horizon domain whose public records CIDRella doesn't hold. The
 * flag round-trips through the zone API for forward and reverse zones of both
 * families, and anything but a boolean is refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    applyInterfaceConfig: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    signalDnsmasq: vi.fn(),
    restartDnsmasq: vi.fn(),
  };
});
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn(), startLeaseWatcher: vi.fn() };
});

const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  const dns = await import('../../../src/routes/dns.js');
  app = createMultiRouterApp([{ prefix: '/api/dns', router: dns.default }]);
});

afterAll(() => cleanupTestDb(tmpDir));

const create = (body) => request(app).post('/api/dns/zones').send(body);
const update = (id, body) => request(app).put(`/api/dns/zones/${id}`).send(body);

describe('zone forward_unknown', () => {
  it.each([
    ['forward', 'local.test', 'forward'],
    ['IPv4 reverse', '50.10.in-addr.arpa', 'reverse'],
    ['IPv6 reverse', '0.0.0.0.0.0.0.0.0.5.0.0.0.d.f.ip6.arpa', 'reverse'],
  ])('a new %s zone answers its own names, and can opt out', async (_label, name, type) => {
    const created = await create({ name, type });
    expect(created.status).toBe(201);
    expect(created.body.forward_unknown).toBe(0);

    const opted = await update(created.body.id, { forward_unknown: true });
    expect(opted.status).toBe(200);
    expect(opted.body.forward_unknown).toBe(1);

    // An edit that leaves the flag out keeps it.
    const renamed = await update(created.body.id, { description: 'kept' });
    expect(renamed.body.forward_unknown).toBe(1);

    const back = await update(created.body.id, { forward_unknown: false });
    expect(back.body.forward_unknown).toBe(0);
  });

  it('creates a zone that forwards unknown names when asked', async () => {
    const created = await create({ name: 'split.test', type: 'forward', forward_unknown: true });
    expect(created.status).toBe(201);
    expect(created.body.forward_unknown).toBe(1);
  });

  it('refuses anything but a boolean', async () => {
    expect((await create({ name: 'bad.test', type: 'forward', forward_unknown: 'yes' })).status).toBe(
      400,
    );
    const zone = await create({ name: 'good.test', type: 'forward' });
    expect((await update(zone.body.id, { forward_unknown: 1 })).status).toBe(400);
  });
});
