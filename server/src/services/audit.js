/**
 * The audit trail: every audit row is written here.
 *
 * One row per action a person or CIDRella takes, saying who, how and from
 * where, and for an edit only the fields that changed, each as [old, new].
 * The rules that keep it short and still complete:
 *
 * - an edit that changes nothing writes no row;
 * - a secret (a password, key, token or TOTP field) is recorded as changed,
 *   never its value;
 * - a bulk action is one row, with a count and the first BULK_SAMPLE items;
 * - CIDRella's own actions are rows with actor 'system' and a `source`, one per
 *   change of state (bypass on, bypass off), never one per check.
 *
 * The actor comes from the request the work runs under (utils/request-actor.js),
 * so a daemon restart that a person's edit caused is theirs; work outside any
 * request is the system's. models/audit-log.js does the write.
 */
import { getDb } from '../db/init.js';
import { insertAuditRow } from '../models/audit-log.js';
import { readSetting } from '../models/setting.js';
import { currentRequestContext } from '../utils/request-actor.js';

export const SYSTEM_ACTOR = 'system';
export const BULK_SAMPLE = 20;
export const SECRET_MASK = '(secret)';

const SECRET_FIELD =
  /(^|_)(password|passwd|secret|token|totp|hash|api_key|private_key|psk|key_pem)($|_)/i;

/** Whether a field's value must never reach the audit log. */
export function isSecretField(name) {
  return SECRET_FIELD.test(String(name));
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields that differ between two versions of a record:
 * { field: [old, new] }, secrets masked. Fields only one side has count.
 * `only` limits the comparison to the fields a write could change.
 */
export function changedFields(before, after, { only = null } = {}) {
  const changes = {};
  const keys = only || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  for (const key of keys) {
    const was = before?.[key];
    const now = after?.[key];
    if (same(was, now)) continue;
    changes[key] = isSecretField(key) ? [SECRET_MASK, SECRET_MASK] : [was ?? null, now ?? null];
  }
  return changes;
}

/**
 * The stored values of some settings, { key: value }, for the before and after
 * of a settings write; absent ones are null.
 */
export function settingsSnapshot(keys, db = getDb()) {
  return Object.fromEntries(keys.map((key) => [key, readSetting(db, key)]));
}

/** A list in a bulk row: its size and the first few. */
export function sample(list) {
  const items = [...(list || [])];
  return items.length > BULK_SAMPLE
    ? { count: items.length, first: items.slice(0, BULK_SAMPLE) }
    : { count: items.length, items };
}

function maskDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] =
      isSecretField(key) && (typeof value === 'string' || typeof value === 'number')
        ? SECRET_MASK
        : value;
  }
  return out;
}

/**
 * Write one audit row.
 *
 *   action      '<entity>_<past verb>', e.g. 'dns_zone_updated'
 *   entityType  what was acted on; entityId its id when it has a number
 *   before/after  the record either side of an edit: only changed fields are
 *               kept, and nothing is written when none changed
 *   only        the fields an edit could change, when the records carry more
 *   details     anything else worth keeping (secret-named keys are masked)
 *   source      for CIDRella's own actions: what acted ('proxy-health', ...);
 *               dropped when a person is behind the work
 *   actor, userId, origin, sourceIp  override what the request says (sign-in,
 *               before a session exists)
 *
 * Returns true when a row was written.
 */
export function recordAudit({
  action,
  entityType = null,
  entityId = null,
  before,
  after,
  only = null,
  details = null,
  source = null,
  actor,
  userId,
  origin,
  sourceIp,
  db = getDb(),
}) {
  let body = maskDetails(details);
  if (before !== undefined || after !== undefined) {
    const changes = changedFields(before, after, { only });
    // An edit that changed nothing is not an action, whatever else it names.
    if (Object.keys(changes).length === 0) return false;
    body = { ...(body || {}), changes };
  }
  const request = currentRequestContext();
  const person = actor ?? request?.username ?? null;
  insertAuditRow(db, {
    // An explicit null is kept: a reset database has no row for the old user.
    userId: userId !== undefined ? userId : (request?.userId ?? null),
    action,
    entityType,
    entityId: entityId ?? null,
    details: body,
    actor: person ?? SYSTEM_ACTOR,
    // A named actor with no request behind it is a sign-in, before the session.
    origin: origin ?? (person ? request?.origin || 'ui' : 'system'),
    // A source names what acted when no person did; a person's row has none.
    source: person ? null : (source ?? 'internal'),
    sourceIp: sourceIp ?? request?.ip ?? null,
  });
  return true;
}
