/**
 * Migration 093 (SCOPE-GATEWAY-01): dhcp_scopes.gateway goes. A scope serves
 * its network's gateway, so a stale value in the column changed nothing for a
 * client, and the promise is that nothing served changes with it gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { resolveEffectiveScopeOptions } from '../../src/models/dhcp-scope.js';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scope(
  db,
  { cidr, network, broadcast, prefix, family, routerOf, stale, start, end, mode },
) {
  const subnetId = db
    .prepare(
      `INSERT INTO subnets (name, cidr, network_address, broadcast_address, prefix_length,
         total_addresses, gateway_address, status, address_family)
       VALUES (?, ?, ?, ?, ?, '256', ?, 'allocated', ?)`,
    )
    .run(cidr, cidr, network, broadcast, prefix, routerOf, family).lastInsertRowid;
  const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db
    .prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, ?, ?)')
    .run(subnetId, typeId, start, end).lastInsertRowid;
  return db
    .prepare(
      `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, domain_name,
         address_family, v6_mode)
       VALUES (?, ?, '1h', ?, 'kept.test', ?, ?)`,
    )
    .run(rangeId, subnetId, stale, family, mode).lastInsertRowid;
}

const load = (db, id) =>
  db
    .prepare(
      `SELECT s.*, sub.cidr AS subnet_cidr, sub.gateway_address AS subnet_gateway,
         sub.domain_name AS subnet_domain_name
       FROM dhcp_scopes s JOIN subnets sub ON sub.id = s.subnet_id WHERE s.id = ?`,
    )
    .get(id);

const servedOptions = (db, id) => resolveEffectiveScopeOptions(db, load(db, id)).options;

describe('migration 093: dhcp_scopes.gateway', () => {
  it('drops the column and changes nothing a client is served', () => {
    const { db, migrate } = databaseThrough(92, { tmpDirs });
    const stale = scope(db, {
      cidr: '10.93.0.0/24',
      network: '10.93.0.0',
      broadcast: '10.93.0.255',
      prefix: 24,
      family: 4,
      routerOf: '10.93.0.254',
      stale: '10.93.0.1',
      start: '10.93.0.10',
      end: '10.93.0.200',
      mode: null,
    });
    const noRouter = scope(db, {
      cidr: '10.93.1.0/24',
      network: '10.93.1.0',
      broadcast: '10.93.1.255',
      prefix: 24,
      family: 4,
      routerOf: null,
      stale: '10.93.1.1',
      start: '10.93.1.10',
      end: '10.93.1.200',
      mode: null,
    });
    const v6 = scope(db, {
      cidr: 'fd93::/64',
      network: 'fd93::',
      broadcast: null,
      prefix: 64,
      family: 6,
      routerOf: 'fd93::1',
      stale: null,
      start: 'fd93::10',
      end: 'fd93::ff',
      mode: 'stateful',
    });
    const before = [stale, noRouter, v6].map((id) => servedOptions(db, id));
    const router = (options) => options.find((option) => option.option_code === 3)?.value;
    expect(router(before[0])).toBe('10.93.0.254');
    expect(router(before[1])).toBeUndefined();
    expect(router(before[2])).toBeUndefined();

    migrate(93);

    const columns = db
      .prepare('PRAGMA table_info(dhcp_scopes)')
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain('gateway');
    expect(columns).toEqual(expect.arrayContaining(['lease_time', 'domain_name', 'v6_mode']));
    expect(load(db, stale)).toMatchObject({ lease_time: '1h', domain_name: 'kept.test' });
    expect([stale, noRouter, v6].map((id) => servedOptions(db, id))).toEqual(before);
    db.close();
  });
});
