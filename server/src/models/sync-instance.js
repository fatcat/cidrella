/**
 * The instances that share this data of record (sync_instances), the join
 * tokens a controller hands out, and the credential a member presents
 * (docs/REDUNDANCY-PLAN.md, section 5).
 */
import crypto from 'crypto';
import os from 'os';
import { readSyncState, syncHead, syncStatus, writeSyncState } from '../sync/log.js';
import { canonicalizeIp } from '../utils/address.js';
import { normalizeDuid } from '../utils/duid.js';

export const JOIN_TOKEN_MINUTES = 15;
const JOIN_PREFIX = 'cj1';
const CREDENTIAL_PREFIX = 'cs1';
// A member not heard from for this long no longer holds the change log's
// tombstones back: when it returns it starts over from a snapshot.
const QUIET_MEMBER_DAYS = 30;
// A member asks for changes at least every 25 seconds while it is in contact.
export const CURRENT_MS = 90_000;
// How many changes behind the head a member may be and still count as following.
const FOLLOWING_GAP = 2000;

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
 * the one that serves DHCP (sync/dhcp-active.js: its clients reach it for
 * sure), then the controller, then the members by name.
 * [{ instance_id, name, addresses }].
 */
export function dnsInstances(db) {
  let statement;
  try {
    statement = db.prepare(
      `SELECT instance_id, name, dns_addresses FROM sync_instances WHERE serves_dns = 1
       ORDER BY COALESCE(instance_id = (
         SELECT value FROM settings WHERE key = 'dhcp_active_instance'), 0) DESC,
         is_controller DESC, name, id`,
    );
  } catch {
    // A database from before instances (a migration test resolving options
    // at an old schema): one box, nothing to add.
    return [];
  }
  return statement.all().map((row) => ({
    instance_id: row.instance_id,
    name: row.name,
    addresses: JSON.parse(row.dns_addresses || '[]'),
  }));
}

/**
 * Every address an instance of this CIDRella is known by, lowercased: the
 * one it pairs from and the ones it answers DNS on. An offer from one of
 * them is CIDRella's own DHCP, whichever instance serves it.
 */
export function instanceAddressSet(db) {
  const known = new Set();
  let rows;
  try {
    rows = db.prepare('SELECT address, dns_addresses FROM sync_instances').all();
  } catch {
    return known;
  }
  for (const row of rows) {
    for (const address of [row.address, ...JSON.parse(row.dns_addresses || '[]')]) {
      const canonical = address && canonicalizeIp(String(address));
      if (canonical) known.add(canonical.toLowerCase());
    }
  }
  return known;
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
  serves_dns, dns_addresses, created_at, last_contact_at, cursor, version, schema_version,
  dns_state, dhcp_state`;

export function listInstances(db) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM sync_instances ORDER BY is_controller DESC, name, id`)
    .all();
}

// Every column, the credential hash included. Never sent to a client.
const ALL_COLUMNS = [
  'id',
  'instance_id',
  'name',
  'address',
  'port',
  'fingerprint',
  'credential_hash',
  'is_controller',
  'serves_dns',
  'dns_addresses',
  'created_at',
  'last_contact_at',
  'version',
  'schema_version',
];

/** The whole list as stored, for replaceInstances to put back (sync/restore.js). */
export function exportInstances(db) {
  return db.prepare(`SELECT ${ALL_COLUMNS.join(', ')} FROM sync_instances ORDER BY id`).all();
}

/**
 * Make the list exactly `rows`, as exportInstances gave them: same ids, names,
 * addresses and credential hashes. Every cursor starts empty, since the data
 * the rows now sit in is not the data those cursors counted. The caller holds
 * the transaction.
 */
export function replaceInstances(db, rows) {
  db.prepare('DELETE FROM sync_instances').run();
  const insert = db.prepare(
    `INSERT INTO sync_instances (${ALL_COLUMNS.join(', ')})
     VALUES (${ALL_COLUMNS.map((column) => `@${column}`).join(', ')})`,
  );
  for (const row of rows) insert.run(row);
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

/** A new credential and the hash it is stored as: { credential, hash }. */
export function mintCredential() {
  const secret = newSecret();
  return { credential: `${CREDENTIAL_PREFIX}_${secret}`, hash: sha256(secret) };
}

/**
 * Why `row` (a sync_instances row of a member) cannot be handed something
 * that needs it to be following this controller right now: `{ code, error }`
 * with `schema_mismatch` or `not_current`, or null when it is. `rule` ends
 * the sentence about contact with what was asked for.
 */
export function followingRefusal(db, row, rule) {
  if (row.schema_version !== null && row.schema_version !== syncStatus(db).schema) {
    return {
      code: 'schema_mismatch',
      error:
        `${row.name} runs ${row.version || 'another version'}, not the controller's. ` +
        'Update it to the same version first.',
    };
  }
  const heard = Date.parse(row.last_contact_at || '');
  if (Number.isNaN(heard) || Date.now() - heard > CURRENT_MS) {
    return {
      code: 'not_current',
      error:
        `${row.name} has not been in contact for the last ${CURRENT_MS / 1000} seconds. ` + rule,
    };
  }
  // In contact is not following: its cursor must be near the head. The head
  // moves with every lease, so a member asking every few seconds is allowed
  // to be a little behind.
  const cursor = db.prepare('SELECT cursor FROM sync_instances WHERE id = ?').get(row.id)?.cursor;
  if (cursor === null || cursor === undefined || syncHead(db) - cursor > FOLLOWING_GAP) {
    return {
      code: 'not_current',
      error: `${row.name} is in contact but has not caught up with the controller. ` + rule,
    };
  }
  return null;
}

/**
 * This box becomes the controller in the list: its row is the controller's,
 * and the row of the controller it replaces becomes a member's, reachable at
 * the address this box knew it by. `grantHash` is the hash of a credential
 * made for that instance to come back with (a handover), or null when it has
 * to join again (a forced promotion). `at` (ISO) goes in as that row's last
 * contact: a member row never heard from holds the change log's deletes back
 * for good (lowestMemberCursor), and one that fell silent at `at` does for
 * QUIET_MEMBER_DAYS. The caller holds the transaction.
 */
export function takeControllerRow(db, { former, grantHash = null, at = null }) {
  const self = ownInstanceId(db);
  db.prepare(
    `UPDATE sync_instances SET is_controller = 0, credential_hash = ?,
       address = COALESCE(?, address), port = COALESCE(?, port),
       last_contact_at = COALESCE(?, last_contact_at)
     WHERE is_controller = 1 AND instance_id IS NOT ?`,
  ).run(grantHash, former?.address ?? null, former?.port ?? null, at, self);
  db.prepare(
    'UPDATE sync_instances SET is_controller = 1, credential_hash = NULL WHERE instance_id = ?',
  ).run(self);
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

/** The member with this instance_id as the fencing rule needs it, or null. */
export function memberByInstanceId(db, instanceId) {
  return (
    db
      .prepare(
        `SELECT id, instance_id, name, cursor FROM sync_instances
         WHERE instance_id = ? AND is_controller = 0`,
      )
      .get(instanceId) || null
  );
}

/** What the controller just heard from a member. Host columns: not data of record. */
export function noteContact(
  db,
  id,
  { cursor = null, version = null, schema = null, services = null, duid = null } = {},
) {
  db.prepare(
    `UPDATE sync_instances SET last_contact_at = ?, cursor = COALESCE(?, cursor),
       version = COALESCE(?, version), schema_version = COALESCE(?, schema_version),
       dns_state = COALESCE(?, dns_state), dhcp_state = COALESCE(?, dhcp_state),
       dhcpv6_duid = COALESCE(?, dhcpv6_duid)
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    cursor,
    version,
    schema,
    services?.dns ?? null,
    services?.dhcp ?? null,
    normalizeDuid(duid),
    id,
  );
}

/**
 * The DHCPv6 server DUIDs the instances reported (noteContact): an
 * advertisement carrying one is this CIDRella's own DHCP, whichever instance
 * serves it (utils/dhcpv6-probe.js).
 */
export function instanceDuidSet(db) {
  return new Set(
    db
      .prepare('SELECT dhcpv6_duid FROM sync_instances WHERE dhcpv6_duid IS NOT NULL')
      .all()
      .map((row) => row.dhcpv6_duid),
  );
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
