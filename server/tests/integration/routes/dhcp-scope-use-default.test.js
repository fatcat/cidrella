/**
 * DHCP-01: a default option reaches a scope only when the scope uses it.
 *
 *   - A new scope links (Use default) the add-to-new-scopes options that have
 *     a value, so later edits of the default reach it.
 *   - PUT /scopes takes { code, use_default: true }; an option the scope does
 *     not use is not served, whatever the default holds.
 *   - GET /options counts the scopes using each default.
 *   - Divide copies links as links, and an IPv6 scope's rows keep family 6.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  regenerateConfigs: vi.fn(),
  applyInterfaceConfig: vi.fn(),
  regenerateDnsmasqConf: vi.fn(),
  signalDnsmasq: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => ({
  ...(await importOriginal()),
  regenerateDhcpConfigs: vi.fn(),
  startLeaseWatcher: vi.fn(),
}));

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

async function network(cidr, body) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, create_dhcp_scope: true, ...body });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  const scope = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(created.body.id);
  return { subnetId: created.body.id, scopeId: scope?.id };
}

const rows = (scopeId) =>
  db
    .prepare(
      'SELECT option_code, value, address_family FROM dhcp_scope_options WHERE scope_id = ? ORDER BY option_code',
    )
    .all(scopeId);

async function served(scopeId) {
  const scope = (await request(app).get('/api/dhcp/scopes')).body.find((s) => s.id === scopeId);
  return Object.fromEntries(scope.effective.options.map((o) => [o.option_code, o]));
}

const setDefaults = (family, options, enabledDefaults) =>
  request(app).put('/api/dhcp/options/defaults').send({ family, options, enabledDefaults });

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  enableIpv6(db);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

describe.each([
  {
    family: 4,
    cidr: '10.62.1.0/24',
    body: { gateway_address: '10.62.1.1', domain_name: 'v4.test' },
    code: 42,
    value: '10.62.0.123',
    edited: '10.62.0.124',
    other: 66,
    otherValue: 'tftp.test',
  },
  {
    family: 6,
    cidr: 'fd62:a::/64',
    body: { gateway_policy: 'first', dhcp_v6_mode: 'stateful', domain_name: 'v6.test' },
    code: 56,
    value: 'fd62::123',
    edited: 'fd62::124',
    other: 32,
    otherValue: '7200',
  },
])('IPv$family: Use default', ({ family, cidr, body, code, value, edited, other, otherValue }) => {
  let scopeId;

  it('links a new scope to the add-to-new-scopes defaults with a value', async () => {
    const saved = await setDefaults(
      family,
      [
        { code, value },
        { code: other, value: otherValue },
      ],
      [code],
    );
    expect(saved.status).toBe(200);
    ({ scopeId } = await network(cidr, body));
    expect(rows(scopeId)).toContainEqual({
      option_code: code,
      value: null,
      address_family: family,
    });
    // Not added to new scopes, so not served, though the default has a value.
    expect(rows(scopeId).map((r) => r.option_code)).not.toContain(other);
    const options = await served(scopeId);
    expect(options[code]).toEqual({ option_code: code, value, source: 'default' });
    expect(options[other]).toBeUndefined();
  });

  it('follows an edit of the default, and the editor counts the scope', async () => {
    await setDefaults(
      family,
      [
        { code, value: edited },
        { code: other, value: otherValue },
      ],
      [code],
    );
    expect((await served(scopeId))[code].value).toBe(edited);
    const options = await request(app).get(`/api/dhcp/options?family=${family}`);
    expect(options.body.linkedCounts[code]).toBe(1);
    expect(options.body.linkedCounts[other]).toBeUndefined();
  });

  it('opts in and out through PUT /scopes', async () => {
    const res = await request(app)
      .put(`/api/dhcp/scopes/${scopeId}`)
      .send({ options: [{ code: other, use_default: true }] });
    expect(res.status).toBe(200);
    const linked = Object.fromEntries(res.body.effective.options.map((o) => [o.option_code, o]));
    expect(linked[other]).toEqual({ option_code: other, value: otherValue, source: 'default' });
    // The replace dropped the other link, so that default is no longer served.
    expect(linked[code]).toBeUndefined();

    const ownValue = family === 4 ? '10.62.9.9' : 'fd62::9';
    const ownRes = await request(app)
      .put(`/api/dhcp/scopes/${scopeId}`)
      .send({ options: [{ code, value: ownValue }] });
    expect(ownRes.status).toBe(200);
    expect(rows(scopeId)).toContainEqual({
      option_code: code,
      value: ownValue,
      address_family: family,
    });
    expect((await served(scopeId))[code]).toEqual({
      option_code: code,
      value: ownValue,
      source: 'scope',
    });
  });

  it('refuses a malformed opt-in', async () => {
    for (const option of [
      { code, use_default: 'yes' },
      { code, use_default: true, value: value },
    ]) {
      const res = await request(app)
        .put(`/api/dhcp/scopes/${scopeId}`)
        .send({ options: [option] });
      expect(res.status, JSON.stringify(option)).toBe(400);
    }
  });
});

describe('IPv4 lease time is never a default', () => {
  it('refuses use_default for option 51', async () => {
    const { scopeId } = await network('10.62.2.0/24', { gateway_address: '10.62.2.1' });
    const res = await request(app)
      .put(`/api/dhcp/scopes/${scopeId}`)
      .send({ options: [{ code: 51, use_default: true }] });
    expect(res.status).toBe(400);
  });
});

describe('divide keeps links', () => {
  it.each([
    [4, '10.62.8.0/23', { gateway_address: '10.62.8.1', domain_name: 'd4.test' }, 24, 42],
    [6, 'fd62:b::/64', { gateway_policy: 'first', dhcp_v6_mode: 'stateful' }, 65, 56],
  ])('IPv%i: the children use the same defaults', async (family, cidr, body, prefix, code) => {
    const { subnetId, scopeId } = await network(cidr, body);
    if (!rows(scopeId).some((r) => r.option_code === code)) {
      await request(app)
        .put(`/api/dhcp/scopes/${scopeId}`)
        .send({ options: [{ code, use_default: true }] });
    }
    const res = await request(app)
      .post(`/api/subnets/${subnetId}/divide`)
      .send({ new_prefix: prefix, force: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const children = db
      .prepare(
        `SELECT s.id FROM dhcp_scopes s JOIN subnets sub ON sub.id = s.subnet_id
         WHERE sub.parent_id = ?`,
      )
      .all(subnetId);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(rows(child.id)).toContainEqual({
        option_code: code,
        value: null,
        address_family: family,
      });
      expect(rows(child.id).every((r) => r.address_family === family)).toBe(true);
    }
  });
});
