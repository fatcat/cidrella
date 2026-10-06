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
import { assertBackendShape, ACTIVATIONS, CAPABILITY_KEYS } from '../../src/backends/contract.js';

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
      const caps = h.backend.capabilities();
      for (const key of CAPABILITY_KEYS) expect(typeof caps[key]).toBe('boolean');
    });

    for (const [family, type, value] of [
      ['IPv4', 'A', '10.250.0.10'],
      ['IPv6', 'AAAA', 'fd00:250::10'],
    ]) {
      it(`applies a ${family} record, is idempotent, and applies its removal`, () => {
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

    it('applies the resolver and listen settings idempotently', () => {
      for (const op of ['applyResolver', 'applyListen']) {
        expectApplyResult(noWrites(() => h.backend.dns[op](h.db, { activate: false })));
        expect(noWrites(() => h.backend.dns[op](h.db, { activate: false })).changed).toBe(false);
      }
    });

    for (const [family, mac, duid, ip] of [
      ['IPv4', 'aa:bb:cc:00:25:01', null, '10.250.0.30'],
      ['IPv6', null, '00:01:00:01:aa:bb:cc:dd:00:25:00:02', 'fd00:250::30'],
    ]) {
      it(`applies an ${family} reservation and its removal`, () => {
        const dhcp = h.backend.dhcp;
        expectApplyResult(noWrites(() => dhcp.applyScopes(h.db, { activate: false })));
        const subnetId = h.db
          .prepare(
            `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
               total_addresses, status, address_family)
             VALUES (?, ?, ?, ?, ?, 256, 'allocated', ?)`,
          )
          .run(
            family === 'IPv4' ? '10.250.0.0/24' : 'fd00:250::/64',
            family,
            family === 'IPv4' ? '10.250.0.0' : 'fd00:250::',
            family === 'IPv4' ? '10.250.0.255' : 'fd00:250::ffff:ffff:ffff:ffff',
            family === 'IPv4' ? 24 : 64,
            family === 'IPv4' ? 4 : 6,
          ).lastInsertRowid;
        h.db
          .prepare(
            `INSERT INTO dhcp_reservations (subnet_id, mac_address, duid, iaid, ip_address, hostname, address_family)
             VALUES (?, ?, ?, ?, ?, 'held', ?)`,
          )
          .run(subnetId, mac, duid, duid ? 1 : null, ip, family === 'IPv4' ? 4 : 6);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(true);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(false);
        h.db.prepare('DELETE FROM subnets WHERE id = ?').run(subnetId);
        expect(noWrites(() => dhcp.applyScopes(h.db, { activate: false })).changed).toBe(true);
      });
    }

    it('reads seeded leases in the normalized shape', async () => {
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
      if (!h.tearLeases) return ctx.skip();
      await h.tearLeases();
      expect(await h.backend.dhcp.readLeases(h.readOptions)).toEqual({
        leases: null,
        unsettled: true,
      });
    });

    it('watches leases until stopped, and refuses to release an unidentifiable lease', () => {
      const stop = h.backend.dhcp.watchLeases(() => {});
      expect(typeof stop).toBe('function');
      stop();
      expect(() => h.backend.dhcp.releaseLease({})).not.toThrow();
      expect(h.backend.dhcp.releaseLease({}).released).toBe(false);
      expect(h.backend.dhcp.serverIdentity()).toHaveProperty('duid');
    });

    // A backend without RA (Kea) leaves the role to another one; the
    // registry test checks that some backend fills it.
    it('can send Router Advertisements when it claims the role', () => {
      if (h.backend.roles.includes('ra')) {
        expect(h.backend.capabilities().routerAdvertisements).toBe(true);
      }
    });
  });
}
