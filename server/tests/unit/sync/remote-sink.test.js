/**
 * A member's facts sink (src/sync/remote-sink.js): the clients it hears are
 * held in memory and written to sync_outbox in batches, a fingerprint is one
 * row, leases are dropped, and nothing touches the data of record. The
 * database here is a member's, guards installed, so a write to an estate
 * table would throw.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { makeMember } = await import('../../helpers/member-mode.js');
const { ensureSyncTriggers, MEMBER } = await import('../../../src/sync/log.js');
const { memberSink } = await import('../../../src/sync/facts.js');
const {
  remoteSink,
  flushSeen,
  stopRemoteSink,
  FINGERPRINT_KIND,
  MAX_FINGERPRINT_ROWS,
  MAX_HELD,
  MAX_SEEN_ROWS,
  SEEN_KIND,
  SEEN_PER_ROW,
} = await import('../../../src/sync/remote-sink.js');

let db;
let tmpDir;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  makeMember(db);
  ensureSyncTriggers(db, MEMBER);
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
});
afterEach(() => {
  stopRemoteSink();
  vi.useRealTimers();
  db.prepare('DELETE FROM sync_outbox').run();
});

const rows = (kind) =>
  db
    .prepare('SELECT payload FROM sync_outbox WHERE kind = ? ORDER BY id')
    .all(kind)
    .map((row) => JSON.parse(row.payload));
const writes = () => db.prepare('SELECT total_changes() n').get().n;
const T0 = Date.parse('2026-11-21T12:00:00Z');

describe('the remote sink', () => {
  it('is what a member’s facts go to', () => {
    expect(memberSink).toBe(remoteSink);
  });

  it('holds a client per address, newest time, and writes nothing until a flush', () => {
    const before = writes();
    remoteSink.clientSeen(db, '10.55.0.10', { createRogue: false, source: 'passive' });
    remoteSink.clientSeen(db, 'fd00:55::10', { createRogue: true, source: 'passive' });
    vi.setSystemTime(T0 + 5000);
    for (let i = 0; i < 50; i++) remoteSink.clientSeen(db, '10.55.0.10', { createRogue: true });
    remoteSink.clientSeen(db, '10.55.0.10', { createRogue: false });
    expect(writes()).toBe(before);

    expect(flushSeen(db)).toBe(2);

    // One row for the flush. A rogue flag given once holds for the flush.
    expect(rows(SEEN_KIND)).toEqual([
      {
        seen: [
          { ip: '10.55.0.10', at: T0 + 5000, rogue: 1 },
          { ip: 'fd00:55::10', at: T0, rogue: 1 },
        ],
      },
    ]);
    expect(flushSeen(db)).toBe(0);
    expect(rows(SEEN_KIND)).toHaveLength(1);
  });

  it('ignores what is not an address', () => {
    remoteSink.clientSeen(db, 'not-an-address', {});
    remoteSink.clientSeen(db, null, {});
    remoteSink.clientSeen(db, 42);
    expect(flushSeen(db)).toBe(0);
  });

  it('flushes by itself on a timer', () => {
    remoteSink.clientSeen(db, '10.55.0.11', { createRogue: true });
    remoteSink.clientSeen(db, 'fd00:55::11', { createRogue: false });
    expect(rows(SEEN_KIND)).toHaveLength(0);
    vi.advanceTimersByTime(31_000);
    expect(rows(SEEN_KIND)).toEqual([
      {
        seen: [
          { ip: '10.55.0.11', at: T0, rogue: 1 },
          { ip: 'fd00:55::11', at: T0 },
        ],
      },
    ]);
  });

  it('writes the held addresses out early at the cap, in rows of a bounded size', () => {
    for (let i = 0; i < MAX_HELD; i++) {
      remoteSink.clientSeen(db, `10.${56 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`, {});
    }
    expect(rows(SEEN_KIND)).toHaveLength(0);
    remoteSink.clientSeen(db, 'fd00:55::99', {});

    const written = rows(SEEN_KIND);
    expect(written).toHaveLength(MAX_HELD / SEEN_PER_ROW);
    expect(written.every((row) => row.seen.length === SEEN_PER_ROW)).toBe(true);
    // The one that did not fit is held for the next flush.
    expect(flushSeen(db)).toBe(1);
    expect(rows(SEEN_KIND).at(-1)).toEqual({ seen: [{ ip: 'fd00:55::99', at: T0 }] });
  });

  it('keeps only the newest waiting rows of a kind, and leaves other kinds alone', () => {
    db.prepare("INSERT INTO sync_outbox (kind, payload) VALUES ('audit', '{}')").run();
    for (let i = 0; i < MAX_SEEN_ROWS + 3; i++) {
      vi.setSystemTime(T0 + i);
      remoteSink.clientSeen(db, '10.55.0.12', {});
      flushSeen(db);
    }
    const waiting = rows(SEEN_KIND);
    expect(waiting).toHaveLength(MAX_SEEN_ROWS);
    expect(waiting[0].seen[0].at).toBe(T0 + 3);
    expect(rows('audit')).toHaveLength(1);
  });

  it('queues a fingerprint as one row, with when it was observed', () => {
    const fingerprint = {
      mac_address: 'aa:bb:cc:55:00:10',
      dhcp_fingerprint: '1,3,6,15',
      vendor_class: 'MSFT 5.0',
      dhcp_hostname: 'desk',
      device_type: 'Computer',
      os_family: 'Windows',
      confidence: 80,
      source: 'dhcp',
      raw: '{}',
    };
    remoteSink.fingerprint(db, fingerprint);
    expect(rows(FINGERPRINT_KIND)).toEqual([{ ...fingerprint, at: T0 }]);
  });

  it('keeps only the newest waiting fingerprints', () => {
    const insert = db.prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < MAX_FINGERPRINT_ROWS; i++) insert.run(FINGERPRINT_KIND, '{"old":1}');
    })();
    remoteSink.fingerprint(db, { mac_address: 'aa:bb:cc:55:00:11' });
    const waiting = rows(FINGERPRINT_KIND);
    expect(waiting).toHaveLength(MAX_FINGERPRINT_ROWS);
    expect(waiting.at(-1).mac_address).toBe('aa:bb:cc:55:00:11');
  });

  it('still drops leases', async () => {
    const before = writes();
    const leases = [
      { ip: '10.55.0.10', mac: 'aa:bb:cc:55:00:10', expiresAt: 'infinite' },
      { ip: 'fd00:55::10', expiresAt: 'infinite', dhcpVersion: 6, duid: '00:01', iaid: 1 },
    ];
    expect(await remoteSink.leases(db, leases)).toEqual({ synced: 0, rejected: 0, blocking: [] });
    expect(writes()).toBe(before);
  });

  it('writes no table of the data of record', () => {
    const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const before = ['ip_addresses', 'device_fingerprints', 'ip_events'].map(count);
    remoteSink.clientSeen(db, '10.55.0.13', { createRogue: true });
    remoteSink.clientSeen(db, 'fd00:55::13', { createRogue: true });
    remoteSink.fingerprint(db, { mac_address: 'aa:bb:cc:55:00:13' });
    flushSeen(db);
    expect(['ip_addresses', 'device_fingerprints', 'ip_events'].map(count)).toEqual(before);
  });
});
