import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

const Session = await import('../../../src/models/session.js');

let tmpDir;
let db;
let user;

const MINUTE = 60 * 1000;
const START = new Date('2026-10-09T12:00:00Z');

function setIdle(minutes) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('session_idle_timeout_minutes', ?)",
  ).run(String(minutes));
}

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const id = db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES ('sess-user', 'x', 'admin')")
    .run().lastInsertRowid;
  user = { id, username: 'sess-user' };
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  db.prepare('DELETE FROM sessions').run();
  setIdle(60);
});

afterEach(() => vi.useRealTimers());

describe('createSession', () => {
  it('stores the IPv4 address canonical, a v4-mapped one as plain IPv4', () => {
    expect(Session.createSession(db, user, { ip: '10.0.0.5' }).ip).toBe('10.0.0.5');
    expect(Session.createSession(db, user, { ip: '::ffff:10.0.0.5' }).ip).toBe('10.0.0.5');
  });

  it('stores the IPv6 address canonical', () => {
    expect(Session.createSession(db, user, { ip: '2001:DB8:0::0:1' }).ip).toBe('2001:db8::1');
  });

  it('keeps no address it cannot parse, and caps the browser string', () => {
    const s = Session.createSession(db, user, { ip: 'junk', userAgent: 'x'.repeat(1000) });
    expect(s.ip).toBeNull();
    expect(s.user_agent).toHaveLength(256);
  });

  it('expires 24 hours after sign-in', () => {
    const s = Session.createSession(db, user);
    expect(s.expires_at).toBe('2026-10-10 12:00:00');
    expect(Session.sessionTimes(s).expires_in_seconds).toBe(24 * 60 * 60);
  });
});

describe('sessionEndReason', () => {
  it.each([15, 30, 60])('goes idle after %i minutes without activity', (minutes) => {
    setIdle(minutes);
    const s = Session.createSession(db, user);
    vi.setSystemTime(START.getTime() + minutes * MINUTE - 1000);
    expect(Session.sessionEndReason(s)).toBeNull();
    vi.setSystemTime(START.getTime() + minutes * MINUTE);
    expect(Session.sessionEndReason(s)).toBe('idle');
  });

  it('never goes idle at 0, and still ends at 24 hours', () => {
    setIdle(0);
    const s = Session.createSession(db, user);
    vi.setSystemTime(START.getTime() + 23 * 60 * MINUTE);
    expect(Session.sessionEndReason(s)).toBeNull();
    expect(Session.sessionTimes(s).idle_remaining_seconds).toBeNull();
    vi.setSystemTime(START.getTime() + 24 * 60 * MINUTE);
    expect(Session.sessionEndReason(s)).toBe('expired');
  });

  it('ends at 24 hours however recently it was used', () => {
    const s = Session.createSession(db, user);
    vi.setSystemTime(START.getTime() + 24 * 60 * MINUTE - MINUTE);
    const touched = Session.touchSession(db, s.id);
    vi.setSystemTime(START.getTime() + 24 * 60 * MINUTE);
    expect(Session.sessionEndReason(touched)).toBe('expired');
  });

  it('treats an unknown setting value as no inactivity limit', () => {
    setIdle(7);
    expect(Session.idleTimeoutMs()).toBe(0);
  });
});

describe('touchSession', () => {
  it('moves the idle deadline', () => {
    setIdle(15);
    const s = Session.createSession(db, user);
    vi.setSystemTime(START.getTime() + 10 * MINUTE);
    const touched = Session.touchSession(db, s.id);
    vi.setSystemTime(START.getTime() + 20 * MINUTE);
    expect(Session.sessionEndReason(touched)).toBeNull();
    expect(Session.sessionTimes(touched).idle_remaining_seconds).toBe(5 * 60);
  });

  it('does not revive an ended session', () => {
    const s = Session.createSession(db, user);
    Session.endSession(db, s.id, 'logout');
    expect(Session.sessionEndReason(Session.touchSession(db, s.id))).toBe('logout');
  });
});

describe('ending sessions', () => {
  it('ends one session once and audits it', () => {
    const s = Session.createSession(db, user);
    expect(Session.endSession(db, s.id, 'logout')).toBe(true);
    expect(Session.endSession(db, s.id, 'idle')).toBe(false);
    expect(Session.getSession(db, s.id).end_reason).toBe('logout');
    const row = db
      .prepare("SELECT details FROM audit_log WHERE action = 'session_ended' ORDER BY id DESC")
      .get();
    expect(JSON.parse(row.details)).toMatchObject({ session_id: s.id, reason: 'logout' });
  });

  it("ends a user's other sessions and keeps the one named", () => {
    const keep = Session.createSession(db, user);
    const other = Session.createSession(db, user);
    expect(Session.endUserSessions(db, user.id, 'password_changed', { except: keep.id })).toBe(1);
    expect(Session.getSession(db, keep.id).ended_at).toBeNull();
    expect(Session.getSession(db, other.id).end_reason).toBe('password_changed');
  });

  it('lists only live sessions with live, idle ones left out', () => {
    setIdle(15);
    Session.createSession(db, user); // goes idle by the time the list is read
    vi.setSystemTime(START.getTime() + 20 * MINUTE);
    const fresh = Session.createSession(db, user);
    const ended = Session.createSession(db, user);
    Session.endSession(db, ended.id, 'logout');
    expect(Session.listSessions(db, { live: true }).map((s) => s.id)).toEqual([fresh.id]);
    expect(Session.listSessions(db, { userId: user.id })).toHaveLength(3);
  });
});

describe('pruneSessions', () => {
  it('drops ended and abandoned sessions past retention, and keeps the rest', () => {
    vi.useRealTimers();
    const insert = db.prepare(
      'INSERT INTO sessions (id, user_id, username, expires_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      'old-ended',
      user.id,
      'sess-user',
      '2000-01-02 00:00:00',
      '2000-01-01 00:00:00',
      'logout',
    );
    insert.run('old-abandoned', user.id, 'sess-user', '2000-01-02 00:00:00', null, null);
    insert.run('live', user.id, 'sess-user', '2999-01-01 00:00:00', null, null);
    expect(Session.pruneSessions(db, 7).changes).toBe(2);
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'live' }]);
  });
});
