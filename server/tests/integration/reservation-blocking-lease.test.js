/**
 * A lease that holds a DHCP Reservation's address for another client keeps
 * the reservation's client off it: the server will not hand out a leased
 * address. The lease sync releases such a lease at the backend, and a DHCP
 * apply runs the sync, so a reservation that changes client takes effect.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { backend } = await import('../../src/backends/index.js');
const { syncLeasesNow, startLeaseSync } = await import('../../src/services/dhcp-lease-sync.js');
const { applyDhcp } = await import('../../src/services/backend-apply.js');

let db;
let tmpDir;
const released = vi.fn();

function network(cidr, network_address, family, pool, v6Mode = null) {
  const subnetId = db
    .prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
         total_addresses, status, address_family)
       VALUES (?, ?, ?, NULL, ?, '256', 'allocated', ?)`,
    )
    .run(cidr, cidr, network_address, Number(cidr.split('/')[1]), family).lastInsertRowid;
  const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  const rangeId = db
    .prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip) VALUES (?, ?, ?, ?)')
    .run(subnetId, typeId, ...pool).lastInsertRowid;
  const scopeId = db
    .prepare(
      `INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, address_family, v6_mode)
       VALUES (?, ?, '1h', ?, ?)`,
    )
    .run(rangeId, subnetId, family, v6Mode).lastInsertRowid;
  db.prepare(
    'INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip) VALUES (?, ?, ?, ?)',
  ).run(scopeId, rangeId, ...pool);
  return subnetId;
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  const v4 = network('10.9.0.0/24', '10.9.0.0', 4, ['10.9.0.100', '10.9.0.200']);
  const v6 = network('fd00:9::/64', 'fd00:9::', 6, ['fd00:9::100', 'fd00:9::1ff'], 'stateful');
  db.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, enabled, address_family)
     VALUES (?, 'aa:bb:cc:00:00:02', '10.9.0.50', 1, 4)`,
  ).run(v4);
  db.prepare(
    `INSERT INTO dhcp_reservations (subnet_id, duid, iaid, ip_address, enabled, address_family)
     VALUES (?, '00:01:00:01:00:00:00:02', 1, 'fd00:9::50', 1, 6)`,
  ).run(v6);
  backend.dhcp.releaseLease = (lease) => {
    released(lease.ip);
    return { released: true };
  };
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => released.mockClear());

const v4Lease = (ip, mac) => ({
  ip,
  mac,
  hostname: null,
  clientId: null,
  expiresAt: 'infinite',
  dhcpVersion: 4,
});
const v6Lease = (ip, duid) => ({
  ip,
  mac: null,
  hostname: null,
  clientId: duid,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  dhcpVersion: 6,
  duid,
  iaid: 1,
});

describe('a lease on another client’s DHCP Reservation', () => {
  it('is released at the backend, in either family', async () => {
    backend.seedLeases([
      v4Lease('10.9.0.50', 'aa:bb:cc:00:00:01'),
      v6Lease('fd00:9::50', '00:01:00:01:00:00:00:01'),
      v4Lease('10.9.0.120', 'aa:bb:cc:00:00:03'),
    ]);
    const result = await syncLeasesNow(db);
    expect(released.mock.calls.map(([ip]) => ip).sort()).toEqual(['10.9.0.50', 'fd00:9::50']);
    expect(result).toMatchObject({ synced: 1, rejected: 2, released: 2 });
  });

  it('leaves the reservation’s own client alone', async () => {
    backend.seedLeases([
      v4Lease('10.9.0.50', 'AA:BB:CC:00:00:02'),
      v6Lease('fd00:9::50', '00:01:00:01:00:00:00:02'),
    ]);
    const result = await syncLeasesNow(db);
    expect(released).not.toHaveBeenCalled();
    expect(result.blocking).toEqual([]);
  });

  it('is released after a DHCP apply, without waiting for the leases to change', async () => {
    backend.seedLeases([]);
    const stop = startLeaseSync(db);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The reservation's client changes: the lease the server holds is now
    // another client's, and nothing about the leases moves.
    backend.dhcp.readLeases = async () => ({
      leases: [v4Lease('10.9.0.50', 'aa:bb:cc:00:00:01')],
    });
    applyDhcp(db);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toHaveBeenCalledWith('10.9.0.50');
    stop();
  });
});
