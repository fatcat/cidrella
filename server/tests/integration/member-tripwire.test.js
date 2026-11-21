/**
 * The tripwire: on a member, nothing the box does by itself changes the data
 * of record. The work a member's process runs (defaults at boot, the change
 * log check, the lease sync, the proxy's client reports, the DNS and DHCP
 * applies, taking DHCP over and reporting its leases, an audit row, the
 * blocklist bookkeeping) is run here on a member's
 * database, whose guards refuse any such write: none may throw, and the data
 * of record must be what it was.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../helpers/test-db.js');
const { makeMember } = await import('../helpers/member-mode.js');
const { backend } = await import('../../src/backends/index.js');
const { ensureDefaults, initDb } = await import('../../src/db/init.js');
const { memberSink, setFactsSink } = await import('../../src/sync/facts.js');
const { ensureSyncLog, ensureSyncTriggers, estateTables, GUARD_MESSAGE, MEMBER } =
  await import('../../src/sync/log.js');
const { syncLeasesNow } = await import('../../src/services/dhcp-lease-sync.js');
const { sinkClientSeen } = await import('../../src/services/dns-proxy-sinks.js');
const { applyDhcp, applyDns, applyResolver } = await import('../../src/services/backend-apply.js');
const { recordAudit } = await import('../../src/services/audit.js');
const { startDhcpNameSync } = await import('../../src/services/dhcp-lease-ingest.js');
const { ensureCategoryRows, recountBlocklistDomains } =
  await import('../../src/utils/blocklist.js');
const { followDhcp } = await import('../../src/services/dhcp-follow.js');
const { servesDhcpHere } = await import('../../src/sync/dhcp-active.js');
const { stopLeaseReports } = await import('../../src/sync/lease-report.js');
const { ownInstanceId } = await import('../../src/models/sync-instance.js');
const { upsertSetting } = await import('../../src/models/setting.js');

let db;
let tmpDir;
let undoSink;

function estate() {
  return Object.fromEntries(
    estateTables(db).map((table) => [
      table.name,
      db
        .prepare(
          `SELECT ${table.columns.join(', ')} FROM ${table.name} AS r
           WHERE ${table.isEstateRow('r')} ORDER BY ${table.key}`,
        )
        .all(),
    ]),
  );
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  // Something for the applies and the lease sync to work on, both families.
  db.prepare(
    `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status) VALUES ('10.66.0.0/24', 'four', '10.66.0.0', '10.66.0.255', 24, 256, 'allocated')`,
  ).run();
  db.prepare(
    `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status) VALUES ('fd00:66::/64', 'six', 'fd00:66::', NULL, 64, 0, 'allocated')`,
  ).run();
  // The controller has moved DHCP to this member (sync/dhcp-active.js): the
  // settings arrived with a sync, before the guards below.
  upsertSetting(db, 'dhcp_active_instance', ownInstanceId(db));
  upsertSetting(db, 'dhcp_term', 1);
  makeMember(db);
  ensureSyncTriggers(db, MEMBER);
  undoSink = setFactsSink(memberSink);
});
afterAll(() => {
  stopLeaseReports();
  undoSink();
  cleanupTestDb(tmpDir);
});

describe('a member’s own work', () => {
  it('leaves the data of record alone', async () => {
    const before = estate();
    backend.dhcp.readLeases = async () => ({
      leases: [
        { ip: '10.66.0.10', mac: 'aa:bb:cc:66:00:10', hostname: 'four', expiresAt: 'infinite' },
        {
          ip: 'fd00:66::10',
          hostname: 'six',
          expiresAt: 'infinite',
          dhcpVersion: 6,
          duid: '00:01:00:01:00:00:00:66',
          iaid: 1,
        },
      ],
    });

    startDhcpNameSync();
    await ensureDefaults({ owner: false });
    ensureSyncLog(db, tmpDir);
    // Given DHCP, the member loads the leases into its server and starts it,
    // then reports its leases (to a controller that is not there).
    await followDhcp(db);
    expect(servesDhcpHere(db)).toBe(true);
    await syncLeasesNow(db);
    sinkClientSeen('10.66.0.10');
    sinkClientSeen('fd00:66::10');
    await applyDns(db);
    await applyDhcp(db);
    await applyResolver(db);
    recordAudit({ action: 'tripwire_tested', entityType: 'test' });
    ensureCategoryRows(db);
    recountBlocklistDomains(db);

    expect(estate()).toEqual(before);
    expect(db.prepare("SELECT kind FROM sync_outbox WHERE kind = 'audit'").all()).toHaveLength(1);
  });

  it('boots as a member without repairing or seeding what is not its own', async () => {
    const before = estate();
    db.close();
    db = await initDb(tmpDir);
    expect(estate()).toEqual(before);
    expect(db.prepare("SELECT value FROM sync_state WHERE key = 'mode'").get().value).toBe(MEMBER);
  });

  it('has guards that would have said so', () => {
    expect(() => db.prepare("INSERT INTO folders (name) VALUES ('x')").run()).toThrow(
      GUARD_MESSAGE,
    );
    expect(() => db.prepare('DELETE FROM subnets').run()).toThrow(GUARD_MESSAGE);
  });
});
