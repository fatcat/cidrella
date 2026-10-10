/**
 * Sign-in sessions: every rule about when a login stops working lives here.
 *
 * A login JWT carries a session id (`sid`); the row is the authority. A
 * session ends when any of these happens:
 * - the user signs out (`logout`);
 * - it goes idle longer than session_idle_timeout_minutes (`idle`; 0 means
 *   no inactivity limit);
 * - it reaches its 24 hour limit (`expired`, at every setting, 0 included);
 * - the account changes under it (`password_changed`, `password_reset`,
 *   `role_changed`, `user_deleted`);
 * - an admin ends it (`revoked`) or a restore replaces the database
 *   (`restore`).
 *
 * Activity is a person using the page, reported by POST /api/auth/activity.
 * Requests are not activity: the client polls on timers, and counting those
 * would keep an open dashboard signed in forever.
 */
import crypto from 'crypto';
import { getSetting } from '../db/init.js';
import { insertAuditRow } from './audit-log.js';
import { canonicalizeIp } from '../utils/address.js';

export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const IDLE_TIMEOUT_CHOICES = [0, 15, 30, 60];
const USER_AGENT_MAX = 256;

/** SQLite's datetime('now') shape, UTC, so stored times compare as text. */
function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlTime(text) {
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

/** The inactivity limit in milliseconds; 0 when there is none. */
export function idleTimeoutMs() {
  const minutes = Number(getSetting('session_idle_timeout_minutes'));
  return IDLE_TIMEOUT_CHOICES.includes(minutes) ? minutes * 60 * 1000 : 0;
}

export function createSession(db, user, { ip = null, userAgent = null } = {}) {
  const id = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, user_id, username, created_at, last_activity_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    user.id,
    user.username,
    sqlTime(now),
    sqlTime(now),
    sqlTime(now + SESSION_LIFETIME_MS),
    ip ? canonicalizeIp(ip) || null : null,
    typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_MAX) : null,
  );
  return getSession(db, id);
}

export function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

/**
 * Why a session no longer counts, or null while it does. `ended` covers a
 * row already ended for any reason; a live row past a limit answers the
 * limit, and the caller ends it with that reason.
 */
export function sessionEndReason(session, now = Date.now(), idleMs = idleTimeoutMs()) {
  if (!session) return 'revoked';
  if (session.ended_at) return session.end_reason || 'revoked';
  if (now >= parseSqlTime(session.expires_at)) return 'expired';
  if (idleMs > 0 && now - parseSqlTime(session.last_activity_at) >= idleMs) return 'idle';
  return null;
}

/** The deadlines the client counts down to, in whole seconds from now. */
export function sessionTimes(session, now = Date.now(), idleMs = idleTimeoutMs()) {
  const expiresIn = Math.max(0, Math.floor((parseSqlTime(session.expires_at) - now) / 1000));
  const idleRemaining =
    idleMs > 0
      ? Math.max(0, Math.floor((parseSqlTime(session.last_activity_at) + idleMs - now) / 1000))
      : null;
  return {
    idle_timeout_seconds: idleMs / 1000,
    idle_remaining_seconds: idleRemaining,
    expires_in_seconds: expiresIn,
  };
}

export function touchSession(db, id) {
  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ? AND ended_at IS NULL').run(
    sqlTime(Date.now()),
    id,
  );
  return getSession(db, id);
}

function auditEnded(db, session, reason, actorId) {
  insertAuditRow(db, {
    userId: actorId ?? session.user_id,
    action: 'session_ended',
    entityType: 'session',
    details: { session_id: session.id, username: session.username, reason },
  });
}

/** End one live session. Returns false when it was already ended. */
export function endSession(db, id, reason, { actorId = null } = {}) {
  const session = getSession(db, id);
  if (!session || session.ended_at) return false;
  db.prepare(
    'UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL',
  ).run(sqlTime(Date.now()), reason, id);
  auditEnded(db, session, reason, actorId);
  return true;
}

/** End every live session of a user, but `except` (the caller's own). */
export function endUserSessions(db, userId, reason, { except = null, actorId = null } = {}) {
  const live = db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL')
    .all(userId)
    .filter((s) => s.id !== except);
  const end = db.prepare(
    'UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL',
  );
  const at = sqlTime(Date.now());
  db.transaction(() => {
    for (const session of live) {
      end.run(at, reason, session.id);
      auditEnded(db, session, reason, actorId);
    }
  })();
  return live.length;
}

/**
 * End every live session in a database without auditing each one. The
 * restore runs this on the staged database, whose own restore row is the
 * record.
 */
export function endAllLiveSessions(db, reason) {
  return db
    .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL')
    .run(sqlTime(Date.now()), reason).changes;
}

export function listSessions(db, { userId = null, live = false } = {}) {
  const where = [];
  const params = [];
  if (userId != null) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (live) where.push('ended_at IS NULL');
  const rows = db
    .prepare(
      `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id`,
    )
    .all(...params);
  // A row nobody has used since it went idle or reached 24 hours is still
  // unended in the table; it ends on its next request. It is not live.
  if (!live) return rows;
  const now = Date.now();
  const idleMs = idleTimeoutMs();
  return rows.filter((s) => sessionEndReason(s, now, idleMs) === null);
}

/**
 * Drop sessions older than the audit log keeps its rows: ended ones by when
 * they ended, and ones never ended (abandoned past their 24 hours) by when
 * they expired.
 */
export function pruneSessions(db, days) {
  return db
    .prepare("DELETE FROM sessions WHERE COALESCE(ended_at, expires_at) < datetime('now', ?)")
    .run(`-${parseInt(days, 10) || 7} days`);
}
