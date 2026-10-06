/**
 * An address typed into a request is stored in its canonical spelling, so it
 * is one string with the ip_addresses row for it (IPV6-03, IPV6-19, IPV6-21).
 * IPv6 has many spellings of one address (case, zero compression, leading
 * zeros); a stored 'FD00:1:0:0::1' beside the canonical row 'fd00:1::1' lists
 * twice, counts twice and misses every string comparison.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', async (importOriginal) => {
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
vi.mock('../../../src/backends/dnsmasq/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn(), startLeaseWatcher: vi.fn() };
});

const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  const [subnets, ranges, dhcp] = await Promise.all([
    import('../../../src/routes/subnets.js'),
    import('../../../src/routes/ranges.js'),
    import('../../../src/routes/dhcp.js'),
  ]);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnets.default },
    { prefix: '/api/subnets/:subnetId/ranges', router: ranges.default },
    { prefix: '/api/dhcp', router: dhcp.default },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

async function network(cidr, body) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, ...body });
  expect(configured.status).toBe(200);
  return created.body.id;
}

const subnetRow = (id) =>
  db.prepare('SELECT gateway_address, gateway_policy FROM subnets WHERE id = ?').get(id);
const gatewayRange = (id) =>
  db
    .prepare(
      `SELECT r.start_ip FROM ranges r JOIN range_types t ON t.id = r.range_type_id
        WHERE r.subnet_id = ? AND t.name = 'Gateway'`,
    )
    .get(id);

describe('a gateway in any spelling', () => {
  it('is stored canonical on configure, with the policy it is', async () => {
    const id = await network('fd00:1::/64', { gateway_address: 'FD00:1:0:0::1' });
    expect(subnetRow(id)).toEqual({ gateway_address: 'fd00:1::1', gateway_policy: 'first' });
    expect(gatewayRange(id)).toEqual({ start_ip: 'fd00:1::1' });

    const list = await request(app).get(`/api/subnets/${id}/ips`);
    expect(list.body.ips.map((row) => row.ip_address)).toEqual(['fd00:1::', 'fd00:1::1']);
    const summary = await request(app).get(`/api/subnets/${id}/summary`);
    expect(summary.body.assigned_count).toBe(2);
  });

  it('is stored canonical on PUT and in the configuration preview', async () => {
    const id = await network('fd00:2::/64', { gateway_policy: 'first' });
    const put = await request(app)
      .put(`/api/subnets/${id}`)
      .send({ gateway_address: 'fd00:0002::00ab' });
    expect(put.status).toBe(200);
    expect(subnetRow(id)).toEqual({ gateway_address: 'fd00:2::ab', gateway_policy: 'custom' });
    expect(gatewayRange(id)).toEqual({ start_ip: 'fd00:2::ab' });

    const preview = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: 'fd00:3::/64', gateway_address: 'FD00:3::FFFF:FFFF:FFFF:FFFF' });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).not.toMatch(/FD00:3/);
    expect(JSON.stringify(preview.body)).toContain('fd00:3::ffff:ffff:ffff:ffff');
  });

  it('keeps an IPv4 gateway as it was', async () => {
    const id = await network('10.40.0.0/24', { gateway_address: '10.40.0.1' });
    expect(subnetRow(id)).toEqual({ gateway_address: '10.40.0.1', gateway_policy: 'first' });
  });
});

describe('searching a network for one address (IPV6-04)', () => {
  it('finds an available IPv6 address, and a stored one in any spelling', async () => {
    const id = await network('fd00:5::/64', { gateway_policy: 'first' });
    const search = async (query) =>
      (await request(app).get(`/api/subnets/${id}/ips`).query(query)).body.ips.map((row) => [
        row.ip_address,
        row.allocation_state,
      ]);
    expect(await search({ search: 'fd00:5::5' })).toEqual([['fd00:5::5', 'unassigned']]);
    expect(await search({ search: 'FD00:5:0:0::1' })).toEqual([['fd00:5::1', 'gateway']]);
    expect(await search({ table_search: 'fd00:5:0:0:0:0:0:1' })).toEqual([
      ['fd00:5::1', 'gateway'],
    ]);
    // Outside the prefix there is nothing to list.
    expect(await search({ search: 'fd00:6::5' })).toEqual([]);
  });

  it('finds an available IPv4 address the same way', async () => {
    const id = await network('10.43.0.0/24', { gateway_policy: 'first' });
    const res = await request(app).get(`/api/subnets/${id}/ips`).query({ search: '10.43.0.5' });
    // IPv4 also lists the stored rows the text is a substring of (10.43.0.50...).
    expect(res.body.ips[0].ip_address).toBe('10.43.0.5');
  });
});

describe('range bounds in any spelling', () => {
  it('are stored canonical on create and update, for either family', async () => {
    const id = await network('fd00:4::/64', { gateway_policy: 'first' });
    const custom = db.prepare('SELECT id FROM range_types WHERE is_system = 0 LIMIT 1').get();
    const type =
      custom?.id ??
      db.prepare("INSERT INTO range_types (name, color, is_system) VALUES ('Lab', '#888', 0)").run()
        .lastInsertRowid;

    const created = await request(app)
      .post(`/api/subnets/${id}/ranges`)
      .send({ range_type_id: Number(type), start_ip: 'FD00:4::0100', end_ip: 'fd00:4:0:0::1ff' });
    expect(created.status).toBe(201);
    expect([created.body.start_ip, created.body.end_ip]).toEqual(['fd00:4::100', 'fd00:4::1ff']);

    const updated = await request(app)
      .put(`/api/subnets/${id}/ranges/${created.body.id}`)
      .send({ end_ip: 'FD00:4::2FF' });
    expect(updated.status).toBe(200);
    expect(
      db.prepare('SELECT start_ip, end_ip FROM ranges WHERE id = ?').get(created.body.id),
    ).toEqual({ start_ip: 'fd00:4::100', end_ip: 'fd00:4::2ff' });

    const id4 = await network('10.41.0.0/24', { gateway_policy: 'first' });
    const v4 = await request(app)
      .post(`/api/subnets/${id4}/ranges`)
      .send({ range_type_id: Number(type), start_ip: '10.41.0.100', end_ip: '10.41.0.110' });
    expect(v4.status).toBe(201);
    expect([v4.body.start_ip, v4.body.end_ip]).toEqual(['10.41.0.100', '10.41.0.110']);
  });
});

describe('DHCP scope addresses', () => {
  let v6ScopeId;
  let v4ScopeId;

  beforeAll(async () => {
    const id6 = await network('fd00:b::/64', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    v6ScopeId = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(id6).id;
    const id4 = await network('10.42.0.0/24', { gateway_policy: 'first', create_dhcp_scope: true });
    v4ScopeId = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(id4).id;
  });

  it('stores IPv6 pool bounds canonical on PUT', async () => {
    const res = await request(app)
      .put(`/api/dhcp/scopes/${v6ScopeId}`)
      .send({ start_ip: 'FD00:B::0010', end_ip: 'fd00:b::00ff' });
    expect(res.status).toBe(200);
    const range = db
      .prepare(
        'SELECT r.start_ip, r.end_ip FROM ranges r JOIN dhcp_scopes s ON s.range_id = r.id WHERE s.id = ?',
      )
      .get(v6ScopeId);
    expect(range).toEqual({ start_ip: 'fd00:b::10', end_ip: 'fd00:b::ff' });
  });

  it('refuses an address list of the other family, naming the field', async () => {
    const v4 = await request(app)
      .put(`/api/dhcp/scopes/${v4ScopeId}`)
      .send({ ntp_servers: '["10.0.0.1","fd00::123"]' });
    expect(v4.status).toBe(400);
    expect(v4.body.error).toBe('ntp_servers must list IPv4 addresses on an IPv4 scope');

    const v6 = await request(app)
      .put(`/api/dhcp/scopes/${v6ScopeId}`)
      .send({ dns_servers: '["fd00::53","192.168.1.1"]' });
    expect(v6.status).toBe(400);
    expect(v6.body.error).toBe('dns_servers must list IPv6 addresses on an IPv6 scope');

    const gw = await request(app)
      .put(`/api/dhcp/scopes/${v4ScopeId}`)
      .send({ gateway: '2001:db8::1' });
    expect(gw.status).toBe(400);
  });

  it('stores a same-family address list canonical', async () => {
    const res = await request(app)
      .put(`/api/dhcp/scopes/${v6ScopeId}`)
      .send({ dns_servers: '["FD00:0:0::53"]' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT dns_servers FROM dhcp_scopes WHERE id = ?').get(v6ScopeId)).toEqual({
      dns_servers: '["fd00::53"]',
    });
    const v4 = await request(app)
      .put(`/api/dhcp/scopes/${v4ScopeId}`)
      .send({ ntp_servers: '["10.0.0.1"]' });
    expect(v4.status).toBe(200);
  });
});
