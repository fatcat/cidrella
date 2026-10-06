/**
 * Settings, DHCP, Bulk Change: POST /api/dhcp/scopes/bulk-options(/preview).
 *
 *   - A selected scope gets exactly the enabled options; others it had go,
 *     the pre-catalog scope columns included.
 *   - A blank enabled option is filled from the scope's network, as for a
 *     new scope.
 *   - The preview reports the same change the apply makes and writes nothing.
 *   - save_defaults replaces the family's defaults too.
 *   - IPv6: a SLAAC-only scope is skipped; 24 fills from the network domain.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import {
  DHCP_DEFAULT_NTP_SERVERS,
  DHCP6_DEFAULT_NTP_SERVERS,
} from '../../../src/config/defaults.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyDhcp',
    'applyResolver',
  ]),
);
vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    applyInterfaceConfig: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    signalDnsmasq: vi.fn(),
    restartDnsmasq: vi.fn(),
  };
});

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;
const scopes = {};

async function network(cidr, body) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, create_dhcp_scope: true, ...body });
  expect(configured.status).toBe(200);
  return db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(created.body.id).id;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  enableIpv6(db);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
  scopes.a = await network('10.61.1.0/24', {
    gateway_address: '10.61.1.1',
    domain_name: 'a.test',
  });
  scopes.b = await network('10.61.2.0/24', {
    gateway_address: '10.61.2.1',
    domain_name: 'b.test',
  });
  scopes.v6 = await network('fd61:a::/64', {
    gateway_policy: 'first',
    dhcp_v6_mode: 'stateful',
    domain_name: 'v6.test',
  });
  scopes.slaac = await network('fd61:b::/64', {
    gateway_policy: 'first',
    dhcp_v6_mode: 'slaac',
    domain_name: 'slaac.test',
  });
});

afterAll(() => cleanupTestDb(tmpDir));

const rows = (scopeId) =>
  Object.fromEntries(
    db
      .prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?')
      .all(scopeId)
      .map((row) => [row.option_code, row.value]),
  );

describe('DHCPv4 bulk change', () => {
  const body = {
    family: 4,
    options: [
      { code: 6, value: '10.61.0.53' },
      { code: 42, value: '10.61.0.123' },
      { code: 66, value: 'tftp.test' },
    ],
    enabledDefaults: [1, 3, 6, 15, 66],
  };

  it('previews every scope of the family without writing', async () => {
    db.prepare('UPDATE dhcp_scopes SET ntp_servers = \'["10.61.0.9"]\' WHERE id = ?').run(scopes.a);
    db.prepare(
      "UPDATE dhcp_scope_options SET value = '10.61.0.9' WHERE scope_id = ? AND option_code = 42",
    ).run(scopes.a);
    const before = rows(scopes.a);
    const res = await request(app).post('/api/dhcp/scopes/bulk-options/preview').send(body);
    expect(res.status).toBe(200);
    expect(res.body.scopes.map((scope) => scope.id)).toEqual([scopes.a, scopes.b]);
    const changes = Object.fromEntries(
      res.body.scopes.find((scope) => scope.id === scopes.a).changes.map((c) => [c.code, c]),
    );
    expect(changes[6]).toMatchObject({ after: '10.61.0.53' });
    expect(changes[66]).toEqual({ code: 66, before: null, after: 'tftp.test' });
    // 42 is not enabled, so the scope's own NTP goes, but a default with a
    // value is served to every scope without its own: the shipped pool.
    expect(changes[42]).toEqual({
      code: 42,
      before: '10.61.0.9',
      after: DHCP_DEFAULT_NTP_SERVERS,
    });
    // Domain and search list follow the network, as for a new scope.
    expect(changes[15]).toBeUndefined();
    expect(changes[119]).toBeUndefined();
    expect(rows(scopes.a)).toEqual(before);
    expect(db.prepare('SELECT ntp_servers FROM dhcp_scopes WHERE id = ?').get(scopes.a)).toEqual({
      ntp_servers: '["10.61.0.9"]',
    });
  });

  it('applies to the selected scopes only, filling blanks from the network', async () => {
    const untouched = rows(scopes.b);
    const preview = await request(app).post('/api/dhcp/scopes/bulk-options/preview').send(body);
    const res = await request(app)
      .post('/api/dhcp/scopes/bulk-options')
      .send({ ...body, scope_ids: [scopes.a] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([scopes.a]);
    expect(rows(scopes.a)).toEqual({
      1: '255.255.255.0',
      3: '10.61.1.1',
      6: '10.61.0.53',
      15: 'a.test',
      28: '10.61.1.255',
      66: 'tftp.test',
      119: 'a.test',
    });
    expect(db.prepare('SELECT ntp_servers FROM dhcp_scopes WHERE id = ?').get(scopes.a)).toEqual({
      ntp_servers: null,
    });
    expect(rows(scopes.b)).toEqual(untouched);
    // The scope now matches; the preview had said exactly this.
    const after = await request(app).post('/api/dhcp/scopes/bulk-options/preview').send(body);
    expect(after.body.scopes.find((scope) => scope.id === scopes.a).changes).toEqual([]);
    expect(preview.body.scopes.find((scope) => scope.id === scopes.b).changes).toEqual(
      after.body.scopes.find((scope) => scope.id === scopes.b).changes,
    );
  });

  it('saves the defaults too when asked, and only then', async () => {
    const res = await request(app)
      .post('/api/dhcp/scopes/bulk-options')
      .send({ ...body, scope_ids: [scopes.b], save_defaults: true });
    expect(res.status).toBe(200);
    const defaults = await request(app).get('/api/dhcp/options?family=4');
    expect(defaults.body.defaults).toEqual({
      6: '10.61.0.53',
      42: '10.61.0.123',
      66: 'tftp.test',
    });
    expect([...defaults.body.enabledDefaults].sort((a, b) => a - b)).toEqual([1, 3, 6, 15, 66]);
    expect(rows(scopes.b)[15]).toBe('b.test');
  });

  it('answers the shipped defaults for a reset', async () => {
    const res = await request(app).get('/api/dhcp/options?family=4');
    expect(res.body.shipped).toEqual({
      defaults: { 42: DHCP_DEFAULT_NTP_SERVERS },
      enabledDefaults: [1, 3, 6, 15, 119, 42],
    });
  });

  it('refuses a bad request', async () => {
    const post = (extra) =>
      request(app)
        .post('/api/dhcp/scopes/bulk-options')
        .send({ ...body, ...extra });
    expect((await post({ scope_ids: [] })).status).toBe(400);
    expect((await post({ scope_ids: 'all' })).status).toBe(400);
    expect((await post({ scope_ids: [scopes.v6] })).status).toBe(404);
    expect((await post({ scope_ids: [scopes.a], enabledDefaults: [0] })).status).toBe(400);
    expect((await post({ scope_ids: [scopes.a], save_defaults: 'yes' })).status).toBe(400);
    expect(
      (await post({ scope_ids: [scopes.a], options: [{ code: 6, value: 'a\nb' }] })).status,
    ).toBe(400);
  });
});

describe('DHCPv6 bulk change', () => {
  const body = {
    family: 6,
    options: [{ code: 56, value: 'fd61::123' }],
    enabledDefaults: [24, 56],
  };

  it('skips a SLAAC-only scope and fills the search list from the network', async () => {
    const preview = await request(app).post('/api/dhcp/scopes/bulk-options/preview').send(body);
    expect(preview.status).toBe(200);
    const slaac = preview.body.scopes.find((scope) => scope.id === scopes.slaac);
    expect(slaac).toMatchObject({ skip_reason: 'SLAAC only, sends no options', changes: [] });
    const res = await request(app)
      .post('/api/dhcp/scopes/bulk-options')
      .send({ ...body, scope_ids: [scopes.v6, scopes.slaac] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([scopes.v6]);
    expect(rows(scopes.v6)).toEqual({ 24: 'v6.test', 56: 'fd61::123' });
  });

  it('answers the IPv6 shipped defaults', async () => {
    const res = await request(app).get('/api/dhcp/options?family=6');
    expect(res.body.shipped).toEqual({
      defaults: { 56: DHCP6_DEFAULT_NTP_SERVERS },
      enabledDefaults: [23, 24, 56],
    });
  });

  it('refuses IPv6 with the switch off', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'ipv6_enabled'").run();
    const res = await request(app).post('/api/dhcp/scopes/bulk-options/preview').send(body);
    enableIpv6(db);
    expect(res.status).toBe(400);
  });
});
