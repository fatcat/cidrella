/**
 * The instances that share this data of record (sync_instances), the join
 * tokens a controller hands out, and the credential a member presents
 * (docs/REDUNDANCY-PLAN.md, section 5).
 */
import crypto from 'crypto';
import os from 'os';
import { readSyncState, writeSyncState } from '../sync/log.js';
import { canonicalizeIp } from '../utils/address.js';

export const JOIN_TOKEN_MINUTES = 15;
const JOIN_PREFIX = 'cj1';
const CREDENTIAL_PREFIX = 'cs1';
// A member not heard from for this long no longer holds the change log's
// tombstones back: when it returns it starts over from a snapshot.
const QUIET_MEMBER_DAYS = 30;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');

/** This box's own id, made once. */
export function ownInstanceId(db) {
  let id = readSyncState(db, 'instance_id');
  if (!id) {
    id = crypto.randomUUID();
    writeSyncState(db, 'instance_id', id);
  }
  return id;
}

/** This box's name among the instances: what it was given, else its host name. */
export function ownInstanceName(db) {
  return readSyncState(db, 'instance_name') || os.hostname();
}

const MAX_DNS_ADDRESSES = 32;

// A list of addresses as it is stored: valid ones, canonical, either family,
// the rule listenableAddresses (utils/interface-config.js) binds by.
function cleanAddresses(addresses) {
  const out = (Array.isArray(addresses) ? addresses : [])
    .map((address) => canonicalizeIp(String(address)))
    // Link-local is no use to a client on another link.
    .filter((address) => address && !/^fe[89ab]/i.test(address));
  return JSON.stringify([...new Set(out)].slice(0, MAX_DNS_ADDRESSES));
}

/** Record the addresses an instance answers DNS on. True when they changed. */
export function setDnsAddresses(db, id, addresses) {
  const stored = cleanAddresses(addresses);
  return (
    db
      .prepare(
        'UPDATE sync_instances SET dns_addresses = ? WHERE id = ? AND dns_addresses IS NOT ?',
      )
      .run(stored, id, stored).changes === 1
  );
}

/** Record the addresses this box, the controller, answers DNS on. True when they changed. */
export function setOwnDnsAddresses(db, addresses) {
  const own = db
    .prepare('SELECT id FROM sync_instances WHERE instance_id = ?')
    .get(ownInstanceId(db));
  return Boolean(own) && setDnsAddresses(db, own.id, addresses);
}

/**
 * The instances that answer DNS, in the order their addresses are served:
 * the controller, then the members by name. [{ name, addresses }].
 */
export function dnsInstances(db) {
  let statement;
  try {
    statement = db.prepare(
      `SELECT name, dns_addresses FROM sync_instances WHERE serves_dns = 1
       ORDER BY is_controller DESC, name, id`,
    );
  } catch {
    // A database from before instances (a migration test resolving options
    // at an old schema): one box, nothing to add.
    return [];
  }
  return statement
    .all()
    .map((row) => ({ name: row.name, addresses: JSON.parse(row.dns_addresses || '[]') }));
}

/**
 * The controller's own row, made or brought up to date. Only the controller
 * calls this: the row is data of record.
 */
export function ensureOwnInstance(db, { fingerprint, port, version, dnsAddresses = [] }) {
  const instanceId = ownInstanceId(db);
  const name = ownInstanceName(db);
  db.prepare(
    `INSERT INTO sync_instances
       (instance_id, name, port, fingerprint, is_controller, version, dns_addresses)
     VALUES (@instanceId, @name, @port, @fingerprint, 1, @version, @dns)
     ON CONFLICT(instance_id) DO UPDATE SET name = excluded.name, port = excluded.port,
       fingerprint = excluded.fingerprint, is_controller = 1, version = excluded.version,
       dns_addresses = excluded.dns_addresses`,
  ).run({ instanceId, name, port, fingerprint, version, dns: cleanAddresses(dnsAddresses) });
  return instanceId;
}

const PUBLIC_COLUMNS = `id, instance_id, name, address, port, fingerprint, is_controller,
  serves_dns, dns_addresses, created_at, last_contact_at, cursor, version, schema_version`;

export function listInstances(db) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM sync_instances ORDER BY is_controller DESC, name, id`)
    .all();
}

export function countMembers(db) {
  return db.prepare('SELECT count(*) AS n FROM sync_instances WHERE is_controller = 0').get().n;
}

/**
 * A join token: one use, JOIN_TOKEN_MINUTES long, carrying the fingerprint of
 * this controller's sync certificate so the joining box trusts nothing on
 * first use. Returns { token, expires_at }.
 */
export function createJoinToken(db, { fingerprint, createdBy = null }) {
  const secret = newSecret();
  const expiresAt = new Date(Date.now() + JOIN_TOKEN_MINUTES * 60_000).toISOString();
  db.prepare('DELETE FROM sync_join_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(
    new Date().toISOString(),
  );
  db.prepare(
    'INSERT INTO sync_join_tokens (token_hash, created_by, expires_at) VALUES (?, ?, ?)',
  ).run(sha256(secret), createdBy, expiresAt);
  return { token: `${JOIN_PREFIX}_${fingerprint}_${secret}`, expires_at: expiresAt };
}

/** The parts of a join token, or null when it is not one. */
export function parseJoinToken(token) {
  const match = /^cj1_([0-9a-f]{64})_([\w-]{20,})$/.exec(String(token || '').trim());
  return match ? { fingerprint: match[1], secret: match[2] } : null;
}

/** Use up a join token. True when it was good: known, unused and in time. */
export function redeemJoinToken(db, token) {
  const parsed = parseJoinToken(token);
  if (!parsed) return false;
  const { changes } = db
    .prepare(
      `UPDATE sync_join_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(new Date().toISOString(), sha256(parsed.secret), new Date().toISOString());
  return changes === 1;
}

/**
 * Take a box in as a member, or give one that joined before a new credential.
 * Returns the credential, which is shown once and stored hashed.
 */
export function addMember(db, { instanceId, name, address, port, fingerprint, version, schema }) {
  const secret = newSecret();
  db.prepare(
    `INSERT INTO sync_instances
       (instance_id, name, address, port, fingerprint, credential_hash, is_controller, version,
        schema_version)
     VALUES (@instanceId, @name, @address, @port, @fingerprint, @hash, 0, @version, @schema)
     ON CONFLICT(instance_id) DO UPDATE SET name = excluded.name, address = excluded.address,
       port = excluded.port, fingerprint = excluded.fingerprint,
       credential_hash = excluded.credential_hash, is_controller = 0,
       version = excluded.version, schema_version = excluded.schema_version`,
  ).run({ instanceId, name, address, port, fingerprint, hash: sha256(secret), version, schema });
  return `${CREDENTIAL_PREFIX}_${secret}`;
}

/** The member a credential belongs to, or null. */
export function memberForCredential(db, credential) {
  const match = /^cs1_([\w-]{20,})$/.exec(String(credential || ''));
  if (!match) return null;
  const hash = sha256(match[1]);
  const given = Buffer.from(hash);
  return (
    db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS}, credential_hash FROM sync_instances
         WHERE is_controller = 0 AND credential_hash IS NOT NULL`,
      )
      .all()
      .find((row) => crypto.timingSafeEqual(Buffer.from(row.credential_hash), given)) || null
  );
}

/** What the controller just heard from a member. Host columns: not data of record. */
export function noteContact(db, id, { cursor = null, version = null, schema = null } = {}) {
  db.prepare(
    `UPDATE sync_instances SET last_contact_at = ?, cursor = COALESCE(?, cursor),
       version = COALESCE(?, version), schema_version = COALESCE(?, schema_version)
     WHERE id = ?`,
  ).run(new Date().toISOString(), cursor, version, schema, id);
}

/** Remove a member. False when the row is the controller's or is not there. */
export function removeMember(db, id) {
  return (
    db.prepare('DELETE FROM sync_instances WHERE id = ? AND is_controller = 0').run(id).changes ===
    1
  );
}

/**
 * The lowest cursor among the members still being heard from: deletes up to
 * it have reached every copy. Null when there are no such members.
 */
export function lowestMemberCursor(db) {
  const since = new Date(Date.now() - QUIET_MEMBER_DAYS * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT MIN(COALESCE(cursor, 0)) AS cursor FROM sync_instances
       WHERE is_controller = 0 AND (last_contact_at IS NULL OR last_contact_at > ?)`,
    )
    .get(since).cursor;
}
