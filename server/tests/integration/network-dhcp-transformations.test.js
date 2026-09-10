import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../helpers/test-db.js';
import { createMultiRouterApp } from '../helpers/test-app.js';
import { expectedIpv4Split } from '../helpers/network-dhcp-oracle.js';

vi.mock('../../src/utils/dnsmasq.js', async (importOriginal) => ({
  ...await importOriginal(),
  regenerateConfigs: vi.fn(),
  applyInterfaceConfig: vi.fn(),
  regenerateDnsmasqConf: vi.fn(),
  signalDnsmasq: vi.fn(),
  restartDnsmasq: vi.fn()
}));
vi.mock('../../src/utils/dhcp.js', async (importOriginal) => ({
  ...await importOriginal(),
  regenerateDhcpConfigs: vi.fn(),
  startLeaseWatcher: vi.fn()
}));

const { default: subnetRouter } = await import('../../src/routes/subnets.js');
const { default: dhcpRouter } = await import('../../src/routes/dhcp.js');
const { default: rangeRouter } = await import('../../src/routes/ranges.js');
const { default: request } = await import('supertest');
const { getDb } = await import('../../src/db/init.js');
const { ipToLong } = await import('../../src/utils/ip.js');

let app;
let tmpDir;

beforeAll(async () => {
  ({ tmpDir } = await setupTestDb());
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter }
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

async function createAndConfigure(cidr, fields = {}) {
  const created = await request(app).post('/api/subnets').send({ cidr, name: cidr });
  expect(created.status).toBe(201);
  const configured = await request(app).post(`/api/subnets/${created.body.id}/configure`).send({
    name: cidr,
    gateway_policy: 'last',
    create_reverse_dns: false,
    create_dhcp_scope: false,
    ...fields
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  return configured.body;
}

async function previewAndDivide(parentId, body) {
  const preview = await request(app).post(`/api/subnets/${parentId}/divide/preview`).send(body);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.plan.conflicts).toEqual([]);
  const result = await request(app).post(`/api/subnets/${parentId}/divide`).send({
    ...body,
    force: true,
    plan_token: preview.body.plan.dependency_token,
    plan_id: preview.body.plan.plan_id
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.children;
}

function poolRows(subnetIds) {
  const marks = subnetIds.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT scope.id AS scope_id, scope.subnet_id, scope.enabled, scope.lease_time,
      pool.start_ip, pool.end_ip,
      (SELECT value FROM dhcp_scope_options
       WHERE scope_id = scope.id AND option_code = 3) AS router
    FROM dhcp_scopes scope
    JOIN dhcp_scope_pools pool ON pool.scope_id = scope.id
    WHERE scope.subnet_id IN (${marks})
    ORDER BY pool.start_ip
  `).all(...subnetIds).sort((a, b) => ipToLong(a.start_ip) - ipToLong(b.start_ip));
}

function leafRows(rootId) {
  return getDb().prepare(`
    WITH RECURSIVE tree AS (
      SELECT * FROM subnets WHERE parent_id = ?
      UNION ALL
      SELECT child.* FROM subnets child JOIN tree parent ON child.parent_id = parent.id
    )
    SELECT * FROM tree
    WHERE NOT EXISTS (SELECT 1 FROM subnets child WHERE child.parent_id = tree.id)
  `).all(rootId).sort((a, b) => ipToLong(a.network_address) - ipToLong(b.network_address));
}

function relativeSemantics(rootCidr, leaves) {
  const rootBase = ipToLong(rootCidr.split('/')[0]);
  return {
    networks: leaves.map(leaf => [
      ipToLong(leaf.network_address) - rootBase,
      leaf.prefix_length,
      leaf.gateway_policy,
      leaf.gateway_address ? ipToLong(leaf.gateway_address) - rootBase : null
    ]),
    pools: poolRows(leaves.map(leaf => leaf.id)).map(pool => [
      ipToLong(pool.start_ip) - rootBase,
      ipToLong(pool.end_ip) - rootBase,
      pool.router ? ipToLong(pool.router) - rootBase : null
    ])
  };
}

describe('canonical cross-model network transformations', () => {
  it('previews and creates default-sized pools for every child of a scoped network', async () => {
    const parent = await createAndConfigure('192.0.2.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '192.0.2.33',
      dhcp_end_ip: '192.0.2.128'
    });
    const sourceScope = getDb().prepare(
      'SELECT id, lease_time FROM dhcp_scopes WHERE subnet_id = ?'
    ).get(parent.id);

    const preview = await request(app)
      .post(`/api/subnets/${parent.id}/divide/preview`)
      .send({ new_prefix: 25 });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.plan.targets.map(target => ({
      cidr: target.cidr,
      origin: target.scopes[0].origin,
      intervals: target.scopes[0].intervals.map(pool => [pool.start_ip, pool.end_ip])
    }))).toEqual([
      { cidr: '192.0.2.0/25', origin: 'default', intervals: [['192.0.2.17', '192.0.2.32']] },
      { cidr: '192.0.2.128/25', origin: 'default', intervals: [['192.0.2.145', '192.0.2.160']] }
    ]);

    const result = await request(app).post(`/api/subnets/${parent.id}/divide`).send({
      new_prefix: 25,
      force: true,
      plan_token: preview.body.plan.dependency_token,
      plan_id: preview.body.plan.plan_id
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(poolRows(result.body.children.map(child => child.id)).map(pool => [
      pool.start_ip, pool.end_ip, pool.lease_time
    ])).toEqual([
      ['192.0.2.17', '192.0.2.32', sourceScope.lease_time],
      ['192.0.2.145', '192.0.2.160', sourceScope.lease_time]
    ]);
    expect(result.body.pool_adjustments).toContainEqual(expect.objectContaining({
      child_cidr: '192.0.2.0/25',
      reason: 'default_scope_created',
      pool_now: { start_ip: '192.0.2.17', end_ip: '192.0.2.32' }
    }));
    expect(result.body.pool_adjustments).toContainEqual(expect.objectContaining({
      child_cidr: '192.0.2.128/25',
      reason: 'default_scope_created',
      pool_now: { start_ip: '192.0.2.145', end_ip: '192.0.2.160' }
    }));

    const children = result.body.children;
    // "Any child has a scope" is sufficient. Remove the lower child's scope
    // and verify merge still creates the merged network's default scope.
    const lowerScope = getDb().prepare(
      'SELECT id FROM dhcp_scopes WHERE subnet_id = ?'
    ).get(children[0].id);
    const lowerRangeIds = getDb().prepare(
      'SELECT range_id FROM dhcp_scope_pools WHERE scope_id = ?'
    ).all(lowerScope.id).map(row => row.range_id);
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(lowerScope.id);
      getDb().prepare('DELETE FROM dhcp_scopes WHERE id = ?').run(lowerScope.id);
      for (const rangeId of lowerRangeIds) {
        getDb().prepare('DELETE FROM ranges WHERE id = ?').run(rangeId);
      }
    })();
    getDb().prepare(`UPDATE ip_addresses SET is_online = 1
      WHERE subnet_id IN (?, ?) AND allocation_source_type = 'topology'`)
      .run(...children.map(child => child.id));
    const mergePreview = await request(app).post('/api/subnets/merge/preview')
      .send({ subnet_ids: children.map(child => child.id) });
    expect(mergePreview.body.plan.targets[0].scopes).toEqual([
      expect.objectContaining({
        origin: 'default',
        intervals: [expect.objectContaining({ start_ip: '192.0.2.33', end_ip: '192.0.2.64' })]
      })
    ]);
    const merged = await request(app).post('/api/subnets/merge').send({
      subnet_ids: children.map(child => child.id),
      plan_token: mergePreview.body.plan.dependency_token,
      plan_id: mergePreview.body.plan.plan_id
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(poolRows([parent.id]).map(pool => [pool.start_ip, pool.end_ip]))
      .toEqual([['192.0.2.33', '192.0.2.64']]);
    expect(getDb().prepare(`SELECT ip_address, is_online, is_rogue, rogue_reason
      FROM ip_addresses WHERE subnet_id = ? AND ip_address IN
      ('192.0.2.126', '192.0.2.127', '192.0.2.128') ORDER BY ip_address`)
      .all(parent.id)).toEqual([
      { ip_address: '192.0.2.126', is_online: 0, is_rogue: 0, rogue_reason: null },
      { ip_address: '192.0.2.127', is_online: 0, is_rogue: 0, rogue_reason: null },
      { ip_address: '192.0.2.128', is_online: 0, is_rogue: 0, rogue_reason: null }
    ]);
  });

  it('creates four default pools and preserves gateways, leases, reservations, and custom ranges', async () => {
    const parent = await createAndConfigure('172.30.0.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '172.30.0.20',
      dhcp_end_ip: '172.30.0.240',
      scan_enabled: false
    });
    const db = getDb();
    db.prepare(`
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '172.30.0.140', '02:00:00:00:01:40', 'leased-host', datetime('now', '+1 hour'))
    `).run(parent.id);
    const reservation = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id,
      ip_address: '172.30.0.210',
      mac_address: '02:00:00:00:02:10',
      hostname: 'reserved-host'
    });
    expect(reservation.status).toBe(201);
    const customType = db.prepare(`
      INSERT INTO range_types (name, color, is_system) VALUES ('Rack segment', '#123456', 0)
    `).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
      VALUES (?, ?, '172.30.0.50', '172.30.0.205', 'spanning range')
    `).run(parent.id, customType);

    const children = await previewAndDivide(parent.id, { new_prefix: 26 });
    expect(children.map(child => [child.cidr, child.gateway_policy, child.gateway_address]))
      .toEqual(expectedIpv4Split('172.30.0.0/24', 26, 'last')
        .map(child => [child.cidr, 'last', child.gateway]));
    expect(children.every(child => child.scan_enabled === 0)).toBe(true);

    const topology = db.prepare(`
      SELECT ip_address, allocation_state FROM ip_addresses
      WHERE subnet_id IN (?, ?, ?, ?)
        AND allocation_source_type = 'topology'
      ORDER BY ip_address
    `).all(...children.map(child => child.id));
    expect(topology.filter(row => row.allocation_state === 'gateway').map(row => row.ip_address))
      .toEqual(['172.30.0.126', '172.30.0.190', '172.30.0.254', '172.30.0.62']);

    expect(poolRows(children.map(child => child.id)).map(row => [
      row.start_ip, row.end_ip, row.router
    ])).toEqual([
      ['172.30.0.9', '172.30.0.16', '172.30.0.62'],
      ['172.30.0.73', '172.30.0.80', '172.30.0.126'],
      ['172.30.0.137', '172.30.0.144', '172.30.0.190'],
      ['172.30.0.201', '172.30.0.208', '172.30.0.254']
    ]);
    expect(db.prepare("SELECT subnet_id FROM dhcp_leases WHERE hostname = 'leased-host'").get().subnet_id)
      .toBe(children[2].id);
    expect(db.prepare("SELECT subnet_id FROM dhcp_reservations WHERE hostname = 'reserved-host'").get().subnet_id)
      .toBe(children[3].id);
    const customRanges = db.prepare(`
      SELECT start_ip, end_ip FROM ranges
      WHERE range_type_id = ?
    `).all(customType).sort((a, b) => ipToLong(a.start_ip) - ipToLong(b.start_ip));
    expect(customRanges).toEqual([
      { start_ip: '172.30.0.50', end_ip: '172.30.0.63' },
      { start_ip: '172.30.0.64', end_ip: '172.30.0.127' },
      { start_ip: '172.30.0.128', end_ip: '172.30.0.191' },
      { start_ip: '172.30.0.192', end_ip: '172.30.0.205' }
    ]);
  });

  it('uses default pool sizing for both an unequal carve and its merge', async () => {
    const parent = await createAndConfigure('172.31.0.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '172.31.0.20',
      dhcp_end_ip: '172.31.0.240'
    });
    const children = await previewAndDivide(parent.id, { cidr: '172.31.0.64/26' });
    expect(children.map(child => child.cidr)).toEqual([
      '172.31.0.0/26', '172.31.0.64/26', '172.31.0.128/25'
    ]);
    const before = poolRows(children.map(child => child.id)).map(row => [row.start_ip, row.end_ip]);
    expect(before).toEqual([
      ['172.31.0.9', '172.31.0.16'],
      ['172.31.0.73', '172.31.0.80'],
      ['172.31.0.145', '172.31.0.160']
    ]);

    const preview = await request(app).post('/api/subnets/merge/preview')
      .send({ subnet_ids: children.map(child => child.id).reverse() });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.merged_cidr).toBe('172.31.0.0/24');
    const merged = await request(app).post('/api/subnets/merge').send({
      subnet_ids: children.map(child => child.id).reverse(),
      plan_token: preview.body.plan.dependency_token,
      plan_id: preview.body.plan.plan_id
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(poolRows([parent.id]).map(row => [row.start_ip, row.end_ip]))
      .toEqual([['172.31.0.33', '172.31.0.64']]);
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('blocks merge when child scope policies differ', async () => {
    const parent = await createAndConfigure('10.232.0.0/24', {
      create_dhcp_scope: true
    });
    const children = await previewAndDivide(parent.id, { new_prefix: 25 });
    getDb().prepare(`UPDATE dhcp_scopes SET lease_time = '8h' WHERE subnet_id = ?`)
      .run(children[1].id);

    const preview = await request(app).post('/api/subnets/merge/preview')
      .send({ subnet_ids: children.map(child => child.id).reverse() });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.plan.conflicts).toContainEqual(expect.objectContaining({
      code: 'dhcp_scope_policy_conflict',
      policy_variants: 2
    }));

    const merge = await request(app).post('/api/subnets/merge').send({
      subnet_ids: children.map(child => child.id).reverse(),
      plan_token: preview.body.plan.dependency_token,
      plan_id: preview.body.plan.plan_id
    });
    expect(merge.status).toBe(409);
    expect(merge.body.conflicts).toContainEqual(expect.objectContaining({
      code: 'dhcp_scope_policy_conflict'
    }));
  });

  it('makes direct and repeated subdivision semantically equivalent', async () => {
    const direct = await createAndConfigure('10.233.0.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '10.233.0.20',
      dhcp_end_ip: '10.233.0.240'
    });
    await previewAndDivide(direct.id, { new_prefix: 26 });

    const repeated = await createAndConfigure('10.234.0.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '10.234.0.20',
      dhcp_end_ip: '10.234.0.240'
    });
    const halves = await previewAndDivide(repeated.id, { new_prefix: 25 });
    for (const half of halves) await previewAndDivide(half.id, { new_prefix: 26 });

    expect(relativeSemantics(direct.cidr, leafRows(direct.id)))
      .toEqual(relativeSemantics(repeated.cidr, leafRows(repeated.id)));
  });

  it('rolls back every affected table when scope projection fails mid-transaction', async () => {
    const parent = await createAndConfigure('10.235.0.0/24', {
      create_dhcp_scope: true,
      dhcp_start_ip: '10.235.0.20',
      dhcp_end_ip: '10.235.0.200'
    });
    const db = getDb();
    const before = {
      subnet: db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id),
      subnets: db.prepare('SELECT COUNT(*) AS count FROM subnets').get().count,
      scopes: db.prepare('SELECT COUNT(*) AS count FROM dhcp_scopes').get().count,
      pools: db.prepare('SELECT COUNT(*) AS count FROM dhcp_scope_pools').get().count,
      ranges: db.prepare('SELECT COUNT(*) AS count FROM ranges').get().count
    };
    db.exec(`
      CREATE TRIGGER fail_scope_projection
      BEFORE INSERT ON dhcp_scopes
      WHEN NEW.subnet_id != ${Number(parent.id)}
      BEGIN SELECT RAISE(ABORT, 'injected scope projection failure'); END
    `);
    const result = await request(app).post(`/api/subnets/${parent.id}/divide`)
      .send({ new_prefix: 25, force: true });
    db.exec('DROP TRIGGER fail_scope_projection');
    expect(result.status).toBe(400);
    expect(db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id)).toEqual(before.subnet);
    expect(db.prepare('SELECT COUNT(*) AS count FROM subnets').get().count).toBe(before.subnets);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_scopes').get().count).toBe(before.scopes);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_scope_pools').get().count).toBe(before.pools);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ranges').get().count).toBe(before.ranges);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
