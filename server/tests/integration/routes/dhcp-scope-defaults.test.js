/**
 * DHCP defaults reach a scope only when it is created.
 *
 *   - A new scope copies the add-to-new-scopes defaults that have a value as
 *     its own rows; a later edit of the default leaves it alone.
 *   - A default not added to new scopes is not served, whatever it holds.
 *   - Divide copies a scope's rows as they are, and an IPv6 scope's rows keep
 *     family 6.
 *   - A new DHCPv4 scope starts with the Lease Time (51) default when it is
 *     marked Add to new scopes, else the default_lease_time setting.
 *   - Migration 091 turns the retired Use default rows into own values.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { databaseThrough } from '../../helpers/migrations.js';

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

const { getSetting } = await import('../../../src/db/init.js');
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
])(
  'IPv$family: defaults are copied at creation',
  ({ family, cidr, body, code, value, edited, other, otherValue }) => {
    let scopeId;

    it("copies the add-to-new-scopes defaults with a value as the scope's own rows", async () => {
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
      expect(rows(scopeId)).toContainEqual({ option_code: code, value, address_family: family });
      // Not added to new scopes, so not served, though the default has a value.
      expect(rows(scopeId).map((r) => r.option_code)).not.toContain(other);
      const options = await served(scopeId);
      expect(options[code]).toEqual({ option_code: code, value, source: 'scope' });
      expect(options[other]).toBeUndefined();
    });

    it('is left alone by a later edit of the default', async () => {
      await setDefaults(
        family,
        [
          { code, value: edited },
          { code: other, value: otherValue },
        ],
        [code],
      );
      expect((await served(scopeId))[code].value).toBe(value);
      expect(rows(scopeId).every((r) => r.value != null)).toBe(true);
    });

    it('takes an own value through PUT /scopes and ignores a use_default flag', async () => {
      const ownValue = family === 4 ? '10.62.9.9' : 'fd62::9';
      const ownRes = await request(app)
        .put(`/api/dhcp/scopes/${scopeId}`)
        .send({ options: [{ code, value: ownValue }] });
      expect(ownRes.status).toBe(200);
      expect((await served(scopeId))[code]).toEqual({
        option_code: code,
        value: ownValue,
        source: 'scope',
      });
      // The retired flag writes nothing: no value, no row.
      const flagged = await request(app)
        .put(`/api/dhcp/scopes/${scopeId}`)
        .send({ options: [{ code: other, use_default: true }] });
      expect(flagged.status).toBe(200);
      expect(rows(scopeId).map((r) => r.option_code)).not.toContain(other);
      expect(rows(scopeId).every((r) => r.value != null)).toBe(true);
    });
  },
);

describe('divide copies rows as they are', () => {
  it.each([
    [4, '10.62.8.0/23', { gateway_address: '10.62.8.1', domain_name: 'd4.test' }, 24, 42],
    [6, 'fd62:b::/64', { gateway_policy: 'first', dhcp_v6_mode: 'stateful' }, 65, 56],
  ])('IPv%i: the children carry the same values', async (family, cidr, body, prefix, code) => {
    const { subnetId, scopeId } = await network(cidr, body);
    const value = rows(scopeId).find((r) => r.option_code === code)?.value;
    expect(value).toBeTruthy();
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
      expect(rows(child.id)).toContainEqual({ option_code: code, value, address_family: family });
      expect(rows(child.id).every((r) => r.address_family === family)).toBe(true);
    }
  });
});

describe('migration 091: Use default rows become own values', () => {
  it('copies the default into each linked row and drops a link to an empty default', () => {
    const { db: m, tmpDir: dir, migrate } = databaseThrough(90);
    const subnetId = m
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
          total_addresses, status, depth, address_family)
         VALUES ('10.91.0.0/24', 'm', '10.91.0.0', '10.91.0.255', 24, 256, 'allocated', 0, 4)`,
      )
      .run().lastInsertRowid;
    const rangeType = m.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const rangeId = m
      .prepare(
        "INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, '10.91.0.10', '10.91.0.20')",
      )
      .run(subnetId, rangeType).lastInsertRowid;
    const scopeId = m
      .prepare(
        "INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family) VALUES (?, ?, '1h', 4)",
      )
      .run(rangeId, subnetId).lastInsertRowid;
    m.prepare(
      `INSERT OR REPLACE INTO dhcp_option_defaults (option_code, value, enabled_by_default, address_family)
       VALUES (6, '10.91.0.2', 1, 4), (42, NULL, 1, 4)`,
    ).run();
    m.prepare(
      `INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family)
       VALUES (?, 6, NULL, 4), (?, 42, NULL, 4), (?, 15, 'own.test', 4)`,
    ).run(scopeId, scopeId, scopeId);
    migrate(91);
    expect(
      m
        .prepare(
          'SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ? ORDER BY option_code',
        )
        .all(scopeId),
    ).toEqual([
      { option_code: 6, value: '10.91.0.2' },
      { option_code: 15, value: 'own.test' },
    ]);
    m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the lease time a new scope starts with', () => {
  const leaseTime = (scopeId) =>
    db.prepare('SELECT lease_time FROM dhcp_scopes WHERE id = ?').get(scopeId).lease_time;

  it('is the Lease Time (51) default when marked Add to new scopes, never linked', async () => {
    await setDefaults(4, [{ code: 51, value: '3600' }], [1, 3, 15, 51]);
    const { scopeId } = await network('10.71.1.0/24', { gateway_address: '10.71.1.1' });
    expect(leaseTime(scopeId)).toBe('3600');
    expect(rows(scopeId).map((row) => row.option_code)).not.toContain(51);
    const scope = (await request(app).get('/api/dhcp/scopes')).body.find((s) => s.id === scopeId);
    expect(scope.effective.lease_time).toBe('3600');
  });

  it('keeps 51 added to new scopes, and falls back to the setting when 51 holds no value', async () => {
    await setDefaults(4, [{ code: 51, value: '3600' }], [1, 3, 15]);
    const defaults = (await request(app).get('/api/dhcp/options?family=4')).body;
    expect(defaults.enabledDefaults).toContain(51);
    expect(defaults.leaseTime).toBe('3600');

    await setDefaults(4, [], [1, 3, 15]);
    const { scopeId } = await network('10.71.2.0/24', { gateway_address: '10.71.2.1' });
    expect(leaseTime(scopeId)).toBe(getSetting('default_lease_time'));
    expect(leaseTime(scopeId)).not.toBe('3600');
  });

  it('starts a DHCPv6 scope from the Address lifetime default, saved with the DHCPv6 defaults', async () => {
    const put = (family, extra) =>
      request(app)
        .put('/api/dhcp/options/defaults')
        .send({ family, options: [], enabledDefaults: [24], ...extra });
    const res = await put(6, { leaseTime: '2h' });
    expect(res.status).toBe(200);
    expect(res.body.leaseTime).toBe('2h');
    expect((await request(app).get('/api/dhcp/options?family=6')).body.leaseTime).toBe('2h');
    const { scopeId } = await network('fd71:2::/64', {
      gateway_policy: 'first',
      dhcp_v6_mode: 'stateful',
    });
    expect(leaseTime(scopeId)).toBe('2h');

    // A save without one leaves it; a bad one, or one on DHCPv4, is refused.
    expect((await put(6, {})).body.leaseTime).toBe('2h');
    expect((await put(6, { leaseTime: '-5' })).status).toBe(400);
    expect((await put(4, { leaseTime: '3600' })).status).toBe(400);
    expect(getSetting('default_lease_time')).toBe('2h');
  });

  it('ignores the 51 default for a DHCPv6 scope, whose 51 is another option', async () => {
    await setDefaults(4, [{ code: 51, value: '3600' }], [1, 3, 15, 51]);
    const { scopeId } = await network('fd71:1::/64', {
      gateway_policy: 'first',
      dhcp_v6_mode: 'stateful',
    });
    expect(leaseTime(scopeId)).toBe(getSetting('default_lease_time'));
  });
});
