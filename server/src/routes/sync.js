/**
 * What instances say to each other (docs/REDUNDANCY-PLAN.md, sections 2 and
 * 5). Mounted ahead of the sign-in middleware: a member presents its own
 * credential, not a user's session, and a box that is joining presents a join
 * token. Only the controller answers.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import zlib from 'zlib';
import { getDb } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { queueRegen } from '../utils/after-commit.js';
import { runDbTask } from '../utils/db-worker/index.js';
import { recordAudit } from '../services/audit.js';
import { AUDIT_OUTBOX_KIND, insertAuditRow } from '../models/audit-log.js';
import { exportChanges, needsSnapshot } from '../sync/changes.js';
import { syncHead, syncStatus } from '../sync/log.js';
import { applyMemberFact, isMemberFact } from '../sync/member-facts.js';
import { sqlTime } from '../utils/sql-time.js';
import { controllerOnly, requireMember } from '../sync/require-member.js';
import {
  addMember,
  noteContact,
  ownInstanceId,
  ownInstanceName,
  redeemJoinToken,
  removeMember,
  setDnsAddresses,
} from '../models/sync-instance.js';

const router = Router();

const MAX_WAIT_SECONDS = 25;
const WAIT_POLL_MS = 500;

// A join token is a secret guessed at most a few times.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many join attempts. Wait a few minutes.', code: 'rate_limited' },
});

router.use(controllerOnly);

const isUuid = (value) => /^[0-9a-f-]{36}$/.test(String(value || ''));
const isFingerprint = (value) => /^[0-9a-f]{64}$/.test(String(value || ''));

// POST /api/sync/join: a join token for a credential.
router.post('/join', joinLimiter, (req, res) => {
  const db = getDb();
  const { token, instance_id, name, port, fingerprint, version, schema } = req.body || {};
  if (
    !isUuid(instance_id) ||
    !isFingerprint(fingerprint) ||
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 255 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return res.status(400).json({ error: 'The join request is malformed.', code: 'bad_request' });
  }
  if (instance_id === ownInstanceId(db)) {
    return res.status(400).json({ error: 'A CIDRella cannot join itself.', code: 'token_refused' });
  }
  // The token first: nothing is told to a caller without one. It is used up
  // with the member's row or not at all, so another schema leaves it good.
  const mismatch = Symbol('schema');
  let credential;
  try {
    credential = db.transaction(() => {
      if (!redeemJoinToken(db, token)) return null;
      if (schema !== syncStatus(db).schema) throw mismatch;
      return addJoiningMember();
    })();
  } catch (err) {
    if (err !== mismatch) throw err;
    return res.status(409).json({
      error:
        `This CIDRella is at version ${APP_VERSION} and the one joining is at ${version || 'another version'}. ` +
        'Update both to the same version, then join.',
      code: 'schema_mismatch',
    });
  }
  if (!credential) {
    return res.status(403).json({
      error: 'The join token is wrong, already used or more than 15 minutes old. Make a new one.',
      code: 'token_refused',
    });
  }
  recordAudit({
    action: 'instance_joined',
    entityType: 'instance',
    source: 'sync',
    details: { name: name.trim(), instance_id, address: req.ip, version },
  });
  res.json({
    credential,
    controller: { instance_id: ownInstanceId(db), name: ownInstanceName(db) },
    version: APP_VERSION,
  });

  function addJoiningMember() {
    return addMember(db, {
      instanceId: instance_id,
      name: name.trim(),
      address: req.ip.replace(/^::ffff:/, ''),
      port,
      fingerprint,
      version: typeof version === 'string' ? version.slice(0, 64) : null,
      schema,
    });
  }
});

// Everything below is a member's, by its credential.
router.use(requireMember);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /api/sync/changes?dataset=&since=&schema=&version=&wait=
 * What the member is missing, gzip, as sync/changes.js writes it. With `wait`
 * and nothing to send, holds the request until something changes or the wait
 * runs out (204).
 */
router.get('/changes', async (req, res) => {
  const db = getDb();
  const local = syncStatus(db);
  const schema = Number(req.query.schema);
  const since = req.query.since === undefined ? null : Number(req.query.since);
  const dataset = typeof req.query.dataset === 'string' ? req.query.dataset : null;
  const version = typeof req.query.version === 'string' ? req.query.version.slice(0, 64) : null;
  if (since !== null && !Number.isSafeInteger(since)) {
    return res.status(400).json({ error: 'since must be a number.', code: 'bad_request' });
  }
  // A cursor counts only where it could be true: it decides which deletes
  // the log may forget.
  const believable = dataset === local.dataset && since !== null && since <= local.head;
  noteContact(db, req.member.id, { cursor: believable ? since : null, version, schema });
  if (typeof req.query.addr === 'string') {
    const addresses = req.query.addr.slice(0, 2048).split(',').filter(Boolean);
    if (setDnsAddresses(db, req.member.id, addresses)) {
      queueRegen('regenerate_dhcp');
      // DHCP clients are sent to these: worth a line in the audit log.
      recordAudit({
        action: 'instance_dns_addresses_changed',
        entityType: 'instance',
        entityId: req.member.id,
        source: 'sync',
        details: { name: req.member.name, addresses },
      });
    }
  }
  if (schema !== local.schema) {
    return res.status(409).json({
      error:
        `The controller is at version ${APP_VERSION} (schema ${local.schema}) and this member is at ` +
        `${version || 'another version'} (schema ${schema}). Update the older one.`,
      code: 'schema_mismatch',
      schema: local.schema,
      version: APP_VERSION,
    });
  }

  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const waitUntil =
    Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(req.query.wait) || 0)) * 1000;
  const snapshot = needsSnapshot(local, { dataset, since });
  if (!snapshot) {
    while (syncHead(db) === since && Date.now() < waitUntil && !closed) await wait(WAIT_POLL_MS);
    if (closed) return;
    if (syncHead(db) === since) return res.status(204).end();
  }
  // A snapshot reads every row: off the event loop, on a connection of its own.
  // A snapshot reads and compresses every row: off the event loop, on a
  // connection of its own.
  const payload = snapshot
    ? Buffer.from(await runDbTask('syncExport', { dbPath: db.name, dataset, since }))
    : zlib.gzipSync(exportChanges(db, { dataset, since }));
  res.set('Content-Type', 'application/x-ndjson');
  res.set('Content-Encoding', 'gzip');
  res.send(payload);
});

const MAX_OUTBOX_ROWS = 500;

/**
 * POST /api/sync/outbox { rows: [{ id, kind, payload }] }
 * What a member has to tell the controller: its audit rows, and what it
 * observed (the clients its DNS proxy heard, DHCP fingerprints), which
 * sync/member-facts.js applies. Answers the ids it took, which the member
 * then forgets. An audit row is a member's word, so it is written as that
 * member's: the origin names it.
 */
router.post('/outbox', (req, res) => {
  const db = getDb();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, MAX_OUTBOX_ROWS) : [];
  // The member says what time it thinks it is: its rows' times are moved by
  // the difference, so a member with a wrong clock still reports the present.
  // A few seconds of travel is not a wrong clock.
  const theirs = Number(req.body?.now);
  const off = Number.isFinite(theirs) ? Date.now() - theirs : 0;
  const skew = Math.abs(off) > 5000 ? off : 0;
  const memberTime = (iso) => {
    const time = Date.parse(iso);
    return Number.isNaN(time) ? null : sqlTime(Math.min(time + skew, Date.now()));
  };
  const taken = [];
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
  // Every row is taken, whatever it holds: one the controller cannot write
  // is dropped with a line in the log, so it never holds up the rest.
  for (const row of rows) {
    if (!Number.isInteger(row?.id)) continue;
    taken.push(row.id);
    const payload = row.payload;
    if (isMemberFact(row.kind)) {
      try {
        applyMemberFact(db, row.kind, payload, skew);
      } catch (err) {
        console.warn(`[sync] dropped a ${row.kind} row from ${req.member.name}: ${err.message}`);
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
        origin: `member:${req.member.name}`.slice(0, 255),
        source: text(payload.source, 100),
        sourceIp: text(payload.sourceIp, 64),
        at: memberTime(payload.at),
      });
    } catch (err) {
      console.warn(`[sync] dropped an audit row from ${req.member.name}: ${err.message}`);
    }
  }
  noteContact(db, req.member.id);
  res.json({ taken });
});

// POST /api/sync/leave: a member that could not finish joining takes itself
// off the list, so its row does not hold the change log's deletes back.
router.post('/leave', (req, res) => {
  removeMember(getDb(), req.member.id);
  queueRegen('regenerate_dhcp');
  recordAudit({
    action: 'instance_left',
    entityType: 'instance',
    entityId: req.member.id,
    source: 'sync',
    details: { name: req.member.name },
  });
  res.status(204).end();
});

export default router;
