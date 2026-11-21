/**
 * What a controller does with the rows of a member's outbox (sync/member.js
 * sends them): the member's audit rows are written as that member's, and
 * what it observed (the clients its DNS proxy heard, DHCP fingerprints) goes
 * where this box's own observations go (sync/member-facts.js).
 *
 * A member that takes over as the controller has an outbox of its own that
 * nobody will ask for: it takes those rows in here itself.
 */
import { AUDIT_OUTBOX_KIND, insertAuditRow } from '../models/audit-log.js';
import { sqlTime } from '../utils/sql-time.js';
import { applyMemberFact, isMemberFact } from './member-facts.js';

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/**
 * Take `rows` ([{ id, kind, payload }]) from the instance named `name`,
 * whose instance_id is `instanceId`.
 * `skew` is how far this box's clock is ahead of the sender's, in ms. Returns
 * the ids taken: every row with one, whatever it holds. A row this box
 * cannot write is dropped with a line in the log, so it never holds up the
 * rest.
 */
export function takeOutboxRows(db, rows, { name, instanceId, skew = 0 }) {
  const memberTime = (iso) => {
    const time = Date.parse(iso);
    return Number.isNaN(time) ? null : sqlTime(Math.min(time + skew, Date.now()));
  };
  const taken = [];
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  for (const row of rows) {
    if (!Number.isInteger(row?.id)) continue;
    taken.push(row.id);
    const payload = row.payload;
    if (isMemberFact(row.kind)) {
      try {
        applyMemberFact(db, row.kind, payload, skew, instanceId);
      } catch (err) {
        console.warn(`[sync] dropped a ${row.kind} row from ${name}: ${err.message}`);
      }
      continue;
    }
    if (row.kind !== AUDIT_OUTBOX_KIND || !payload || typeof payload.action !== 'string') continue;
    try {
      const userId = Number.isInteger(payload.userId) ? payload.userId : null;
      insertAuditRow(db, {
        // The user may have been removed since.
        userId: userId !== null && userExists.get(userId) ? userId : null,
        action: payload.action.slice(0, 100),
        entityType: text(payload.entityType, 100),
        entityId: ['string', 'number'].includes(typeof payload.entityId) ? payload.entityId : null,
        details: payload.details ?? null,
        actor: text(payload.actor, 255),
        // A member's word, so written as that member's: the origin names it.
        origin: `member:${name}`.slice(0, 255),
        source: text(payload.source, 100),
        sourceIp: text(payload.sourceIp, 64),
        at: memberTime(payload.at),
      });
    } catch (err) {
      console.warn(`[sync] dropped an audit row from ${name}: ${err.message}`);
    }
  }
  return taken;
}

const OWN_BATCH = 200;

/**
 * Take in this box's own outbox: what it queued as a member, now that it is
 * the controller. Returns how many rows it took.
 */
export function takeOwnOutbox(db, { name, instanceId }) {
  let count = 0;
  for (;;) {
    const waiting = db
      .prepare('SELECT id, kind, payload FROM sync_outbox ORDER BY id LIMIT ?')
      .all(OWN_BATCH);
    if (waiting.length === 0) return count;
    const rows = waiting.map((row) => {
      let payload = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        /* taken as nothing */
      }
      return { id: row.id, kind: row.kind, payload };
    });
    takeOutboxRows(db, rows, { name, instanceId });
    const forget = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
    db.transaction(() => waiting.forEach((row) => forget.run(row.id)))();
    count += waiting.length;
  }
}
