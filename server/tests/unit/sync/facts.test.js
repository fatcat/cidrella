/**
 * What an instance observes goes to the facts sink (src/sync/facts.js), never
 * straight into the database: with another sink in place, the lease sync, the
 * proxy's client reports and the DHCP fingerprint watcher write nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { setupTestDb, cleanupTestDb } = await import('../../helpers/test-db.js');
const { backend } = await import('../../../src/backends/index.js');
const { facts, setFactsSink } = await import('../../../src/sync/facts.js');
const { localSink } = await import('../../../src/sync/local-sink.js');
const { syncLeasesNow } = await import('../../../src/services/dhcp-lease-sync.js');
const { sinkClientSeen } = await import('../../../src/services/dns-proxy-sinks.js');

let db;
let tmpDir;
let restore = () => {};
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});
afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => restore());

const LEASES = [
  { ip: '10.44.0.10', mac: 'aa:bb:cc:44:00:10', hostname: 'four', expiresAt: 'infinite' },
  {
    ip: 'fd00:44::10',
    hostname: 'six',
    expiresAt: 'infinite',
    dhcpVersion: 6,
    duid: '00:01:00:01:00:00:00:44',
    iaid: 1,
  },
];
const writes = () => db.prepare('SELECT total_changes() n').get().n;

describe('facts sink', () => {
  it('is the local sink unless another is set, and the undo puts it back', () => {
    expect(facts()).toBe(localSink);
    const other = {};
    const undo = setFactsSink(other);
    expect(facts()).toBe(other);
    undo();
    expect(facts()).toBe(localSink);
  });

  it('takes the lease sync: both families go to the sink and nothing is written', async () => {
    const leases = vi.fn(async () => ({ synced: 2, rejected: 0, blocking: [] }));
    restore = setFactsSink({ leases });
    backend.dhcp.readLeases = async () => ({ leases: LEASES });
    const before = writes();

    expect(await syncLeasesNow(db)).toEqual({ synced: 2, rejected: 0, blocking: [] });

    expect(leases).toHaveBeenCalledWith(db, LEASES);
    expect(writes()).toBe(before);
  });

  it('releases at the backend the leases the sink says block a reservation', async () => {
    const released = [];
    backend.dhcp.releaseLease = async (lease) => {
      released.push(lease.ip);
      return { released: true };
    };
    backend.dhcp.readLeases = async () => ({ leases: LEASES });
    restore = setFactsSink({
      leases: async (given, list) => ({ synced: 0, rejected: 2, blocking: list }),
    });

    const result = await syncLeasesNow(db);

    expect(released).toEqual(['10.44.0.10', 'fd00:44::10']);
    expect(result.released).toBe(2);
  });

  it('takes a client the DNS proxy heard from, either family', () => {
    const clientSeen = vi.fn();
    restore = setFactsSink({ clientSeen });
    const before = writes();

    sinkClientSeen('10.44.0.10');
    sinkClientSeen('fd00:44::10');

    expect(clientSeen.mock.calls.map((call) => call[1])).toEqual(['10.44.0.10', 'fd00:44::10']);
    expect(clientSeen.mock.calls[0][2]).toEqual({ createRogue: true, source: 'passive' });
    expect(writes()).toBe(before);
  });
});
