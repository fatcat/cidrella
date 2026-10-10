/**
 * The behavior every DNS/DHCP backend adapter must show (backends/contract.js).
 * Each adapter's test file calls runBackendContract with a harness:
 *
 *   makeHarness() -> {
 *     backend,                 the adapter under test
 *     db,                      a migrated test database
 *     seedLeases(leases),      make the backend report these BackendLeases
 *     readOptions,             passed to readLeases (timing for tests)
 *     tearLeases?(),           make the next read see a half-written lease set
 *   }
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { assertBackendShape, ACTIVATIONS } from '../../src/backends/contract.js';
import { featureById } from '../../src/backends/features.js';
import { network } from '../helpers/backend-estate.js';
import { parseNetwork } from '../../src/utils/cidr.js';

export function runBackendContract(label, makeHarness) {
  describe(`backend contract: ${label}`, () => {
    let h;
    let zoneId;
    beforeAll(async () => {
      h = await makeHarness();
      zoneId = h.db
        .prepare(
          "INSERT INTO dns_zones (name, type, enabled) VALUES ('contract.test', 'forward', 1)",
        )
        .run().lastInsertRowid;
    });

    // Role ops are tested only for the roles the adapter claims: a DHCP-only
    // adapter (Kea) has no dns ops to call.
    const skipUnless = (role, ctx) => {
      if (h.backend.roles.includes(role)) return false;
      ctx.skip();
      return true;
    };

    const expectApplyResult = (result) => {
      expect(typeof result.changed).toBe('boolean');
      expect(ACTIVATIONS).toContain(result.activation);
      expect(typeof result.activated).toBe('boolean');
      expect(result.changed).toBe(result.activation !== 'none');
    };

    // Apply ops read the database and never write it.
    const noWrites = (op) => {
      const before = h.db.prepare('SELECT total_changes() AS n').get().n;
      const result = op();
      expect(h.db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
      return result;
    };

    it('has every operation and reports status and capabilities', () => {
      expect(() => assertBackendShape(h.backend)).not.toThrow();
      const status = h.backend.status();
      expect(status.name).toBe(h.backend.name);
      expect(typeof status.running).toBe('boolean');
      expect(typeof status.restartPending).toBe('boolean');
      // Every feature of the roles it fills, each a boolean, nothing else.
      const caps = h.backend.capabilities();
      for (const [id, value] of Object.entries(caps)) {
        expect(h.backend.roles, id).toContain(featureById(id)?.role);
        expect(typeof value, id).toBe('boolean');
      }
      const notes = h.backend.capabilityNotes?.() || {};
      for (const [id, note] of Object.entries(notes)) {
        expect(caps, id).toHaveProperty(id);
        expect(typeof note, id).toBe('string');
      }
      if (h.backend.roles.includes('dns')) {
        for (const record of [
          { type: 'A', ttl: null },
          { type: 'AAAA', ttl: 900 },
          { type: 'CNAME', ttl: 900 },
        ]) {
          const ttl = h.backend.dns.servedTtl(record);
          expect(Number.isInteger(ttl) && ttl >= 0, `${record.type} ${record.ttl}`).toBe(true);
        }
      }
      const log = h.backend.logSource();
      if (log !== null) {
        // null until the backend has written a log (Kea's legal log).
        expect(log.path === null || typeof log.path === 'string').toBe(true);
        for (const fn of ['querySourceIp', 'dhcpDirection', 'isDhcpLine', 'createDhcpParser']) {
          expect(typeof log[fn]).toBe('function');
        }
      }
    });

    for (const [family, type, value] of [
      ['IPv4', 'A', '10.250.0.10'],
      ['IPv6', 'AAAA', 'fd00:250::10'],
    ]) {
      it(`applies a ${family} record, is idempotent, and applies its removal`, (ctx) => {
        if (skipUnless('dns', ctx)) return;
        const dns = h.backend.dns;
        expectApplyResult(noWrites(() => dns.applyZones(h.db, { activate: false })));
        expect(noWrites(() => dns.applyZones(h.db, { activate: false })).changed).toBe(false);

        const id = h.db
          .prepare(
            "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'host', ?, ?, 'manual', 1)",
          )
          .run(zoneId, type, value).lastInsertRowid;
        const added = noWrites(() => dns.applyZones(h.db, { activate: false }));
        expectApplyResult(added);
        expect(added.changed).toBe(true);
        expect(added.activated).toBe(false);
        expect(noWrites(() => dns.applyZones(h.db, { activate: false })).changed).toBe(false);

        h.db.prepare('DELETE FROM dns_records WHERE id = ?').run(id);
        expect(noWrites(() => dns.applyZones(h.db, { activate: false })).changed).toBe(true);
        expect(noWrites(() => dns.applyZones(h.db, { activate: false })).changed).toBe(false);
      });
    }

    it('applies the resolver and listen settings idempotently', (ctx) => {
      if (skipUnless('dns', ctx)) return;
      for (const op of ['applyResolver', 'applyListen']) {
        expectApplyResult(noWrites(() => h.backend.dns[op](h.db, { activate: false })));
        expect(noWrites(() => h.backend.dns[op](h.db, { activate: false })).changed).toBe(false);
      }
    });

    for (const [family, cidr, mac, duid, ip] of [
      ['IPv4', '10.250.0.0/24', 'aa:bb:cc:00:25:01', null, '10.250.0.30'],
      ['IPv6', 'fd00:250::/64', null, '00:01:00:01:aa:bb:cc:dd:00:25:00:02', 'fd00:250::30'],
    ]) {
      it(`applies an ${family} reservation and its removal`, (ctx) => {
        if (skipUnless('dhcp', ctx)) return;
        const dhcp = h.backend.dhcp;
        // A reservation is served on a network with a DHCP scope.
        const subnetId = network(h.db, cidr, {
          create_dhcp_scope: true,
          ...(family === 'IPv6'
            ? { dhcpV6: { mode: 'stateful', pool: null } }
            : {
                dhcpPool: {
                  startLong: Number(parseNetwork('10.250.0.100/32').networkLong),
                  endLong: Number(parseNetwork('10.250.0.199/32').networkLong),
                },
              }),
        });
        expectApplyResult(noWrites(() => dhcp.applyScopes(h.db, { activate: false })));
        const id = h.db
          .prepare(
            `INSERT INTO dhcp_reservations (subnet_id, mac_address, duid, iaid, ip_address, hostname, address_family)
             VALUES (?, ?, ?, ?, ?, 'held', ?)`,
          )
          .run(subnetId, mac, duid, duid ? 1 : null, ip, family === 'IPv4' ? 4 : 6).lastInsertRowid;
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(true);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(false);
        h.db.prepare('UPDATE dhcp_reservations SET enabled = 0 WHERE id = ?').run(id);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(true);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(false);
      });
    }

    it('reads seeded leases in the normalized shape', async (ctx) => {
      if (skipUnless('dhcp', ctx)) return;
      await h.seedLeases([
        {
          ip: '10.250.0.40',
          mac: 'AA:BB:CC:00:25:40',
          hostname: 'laptop',
          clientId: null,
          expiresAt: '2100-01-01T00:00:00.000Z',
          dhcpVersion: 4,
          duid: null,
          iaid: null,
        },
        {
          ip: 'fd00:250::1040',
          mac: null,
          hostname: null,
          clientId: '00:01:00:01:AA:BB:CC:DD:00:25:00:40',
          expiresAt: '2100-01-01T00:00:00.000Z',
          dhcpVersion: 6,
          duid: '00:01:00:01:aa:bb:cc:dd:00:25:00:40',
          iaid: 40,
          temporary: false,
        },
      ]);
      const { leases } = await h.backend.dhcp.readLeases(h.readOptions);
      const byIp = Object.fromEntries(leases.map((lease) => [lease.ip, lease]));
      expect(byIp['10.250.0.40']).toMatchObject({
        mac: 'aa:bb:cc:00:25:40',
        hostname: 'laptop',
        dhcpVersion: 4,
        expiresAt: '2100-01-01T00:00:00.000Z',
      });
      expect(byIp['fd00:250::1040']).toMatchObject({
        mac: null,
        hostname: null,
        dhcpVersion: 6,
        duid: '00:01:00:01:aa:bb:cc:dd:00:25:00:40',
        iaid: 40,
      });
    });

    it('reports a half-written lease set as unsettled', async (ctx) => {
      if (skipUnless('dhcp', ctx) || !h.tearLeases) return ctx.skip();
      await h.tearLeases();
      expect(await h.backend.dhcp.readLeases(h.readOptions)).toEqual({
        leases: null,
        unsettled: true,
      });
    });

    it('watches leases until stopped, and refuses to release an unidentifiable lease', async (ctx) => {
      if (skipUnless('dhcp', ctx)) return;
      const stop = h.backend.dhcp.watchLeases(() => {});
      expect(typeof stop).toBe('function');
      stop();
      expect((await h.backend.dhcp.releaseLease({})).released).toBe(false);
      expect(h.backend.dhcp.serverIdentity()).toHaveProperty('duid');
    });

    // A backend without RA (Kea) leaves the role to another one; the
    // registry test checks that some backend fills it.
    it('can send Router Advertisements when it claims the role', () => {
      if (h.backend.roles.includes('ra')) {
        expect(h.backend.capabilities().ra).toBe(true);
      }
    });
  });
}
