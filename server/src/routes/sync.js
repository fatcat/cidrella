/**
 * What instances say to each other (docs/REDUNDANCY-PLAN.md, sections 2, 5
 * and 7). Mounted ahead of the sign-in middleware: an instance presents its
 * own credential, not a user's session, and a box that is joining presents a
 * join token. Only the controller answers, except for `hello`, which every
 * instance answers so a member can find the controller, and the two notices
 * a controller that was replaced is sent.
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import zlib from 'zlib';
import { getDb } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { queueRegen } from '../utils/after-commit.js';
import { runDbTask } from '../utils/db-worker/index.js';
import { recordAudit } from '../services/audit.js';
import { exportChanges, needsSnapshot } from '../sync/changes.js';
import { syncHead, syncStatus } from '../sync/log.js';
import { instanceMode, isFenced, isMember } from '../sync/mode.js';
import { epochBase } from '../sync/promotion-state.js';
import { fenceSelf, receiveFence, receiveHandoverDone } from '../services/controller-promotion.js';
import { takeOutboxRows } from '../sync/outbox-intake.js';
import { controllerOnly, epochGate, requireMember } from '../sync/require-member.js';
import { acceptLeaseReport } from '../sync/lease-intake.js';
import {
  LEASE_REPORT_TYPE,
  MAX_REPORT_BYTES,
  NOT_DHCP_ACTIVE,
  unpackReport,
} from '../sync/lease-wire.js';
import { followDhcp } from '../services/dhcp-follow.js';
import { clearHandover, dhcpState, dhcpStateChanged } from '../sync/dhcp-active.js';
import { loadFilteringOverrides } from '../utils/dns-proxy.js';
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

// The fencing rule (sync/require-member.js) is a controller's: a member that
// hears a higher epoch has nothing to give up.
const fencing = epochGate(fenceSelf);
const fencingOnController = (req, res, next) => (isMember() ? next() : fencing(req, res, next));

/**
 * GET /api/sync/hello: who this instance is and whether it is the controller,
 * `{ instance_id, name, mode, epoch, dataset }` with `mode` one of
 * 'controller', 'member' or 'fenced'. Answered in every mode, to a caller
 * that presents a credential of this estate (requireMember says how a member
 * checks one).
 */
router.get('/hello', requireMember, fencingOnController, (req, res) => {
  const db = getDb();
  const status = syncStatus(db);
  res.json({
    instance_id: ownInstanceId(db),
    name: ownInstanceName(db),
    mode: isFenced(db) ? 'fenced' : instanceMode(),
    epoch: status.epoch,
    dataset: status.dataset,
  });
});

const notice = (body) => ({
  epoch: Number(body?.epoch),
  base: Number(body?.base),
  credential: body?.credential,
});

// POST /api/sync/fence { epoch }: a member took over without this
// controller's help and says so. Recorded by receiveFence.
router.post('/fence', requireMember, (req, res) => {
  const outcome = receiveFence(getDb(), req.member, notice(req.body).epoch);
  res.status(outcome.status).json(outcome.body);
});

// POST /api/sync/handover-done { epoch, base, credential }: the member this
// controller handed over to has taken over, and gives it the credential to
// follow with. Recorded by receiveHandoverDone.
router.post('/handover-done', requireMember, (req, res) => {
  const outcome = receiveHandoverDone(getDb(), req.member, notice(req.body));
  res.status(outcome.status).json(outcome.body);
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

// Everything below is a member's, by its credential, and subject to the
// fencing rule.
router.use(requireMember, fencing);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /api/sync/changes?dataset=&epoch=&since=&schema=&version=&wait=
 * What the member is missing, gzip, as sync/changes.js writes it. With `wait`
 * and nothing to send, holds the request until something changes or the wait
 * runs out (204).
 *
 * `epoch` is the epoch the member's copy is from. A cursor means the same
 * thing here only when that is this controller's epoch, or the one before it
 * with the cursor no further than where this box took over (`epoch_base`):
 * past that point the member holds changes of the old controller that this
 * one never had. Any other copy is sent everything.
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
  // A member from before the epoch was sent has only ever followed this one.
  const lineage = req.query.epoch === undefined ? local.epoch : Number(req.query.epoch);
  const base = epochBase(db);
  const sameLine =
    lineage === local.epoch ||
    (lineage === local.epoch - 1 && since !== null && base !== null && since <= base);
  // A cursor counts only where it could be true: it decides which deletes
  // the log may forget.
  const believable = sameLine && dataset === local.dataset && since !== null && since <= local.head;
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
  const snapshot = !sameLine || needsSnapshot(local, { dataset, since });
  if (!snapshot) {
    while (syncHead(db) === since && Date.now() < waitUntil && !closed) await wait(WAIT_POLL_MS);
    if (closed) return;
    if (syncHead(db) === since) return res.status(204).end();
  }
  // A snapshot reads and compresses every row: off the event loop, on a
  // connection of its own. No cursor is passed: the export decides between
  // a snapshot and a delta by it, and this one is a snapshot.
  const payload = snapshot
    ? Buffer.from(await runDbTask('syncExport', { dbPath: db.name, dataset: null, since: null }))
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
  const taken = takeOutboxRows(db, rows, {
    name: req.member.name,
    instanceId: req.member.instance_id,
    skew,
  });
  noteContact(db, req.member.id);
  res.json({ taken });
});

/**
 * POST /api/sync/leases { term, leases } (gzip, sync/lease-wire.js)
 * The whole lease set of the member that serves DHCP. Kept only from the
 * instance that is active at that term (sync/lease-intake.js); anyone else
 * gets 409 `not_dhcp_active`. `final: true` is the last report of a member
 * that lost DHCP, which ends its handover. The body is read here, past the
 * app's JSON parser, which leaves this content type alone.
 */
const unpacking = new Set();
router.post(
  '/leases',
  express.raw({ type: LEASE_REPORT_TYPE, limit: MAX_REPORT_BYTES }),
  async (req, res) => {
    const db = getDb();
    noteContact(db, req.member.id);
    // Only the instance whose leases could count is read at all, and one
    // report of its at a time: unpacking is the costly part.
    const state = dhcpState(db);
    const mine = req.member.instance_id;
    if ((mine !== state.active && mine !== state.handoverFrom) || unpacking.has(mine)) {
      return res.status(409).json({
        error: 'This instance does not serve DHCP.',
        code: NOT_DHCP_ACTIVE,
      });
    }
    unpacking.add(mine);
    let report;
    try {
      report = await unpackReport(req.body);
    } finally {
      unpacking.delete(mine);
    }
    const outcome = acceptLeaseReport(db, req.member, report);
    // A host with filtering off is keyed by MAC; its new address takes effect now.
    if (outcome.status === 200) loadFilteringOverrides();
    if (outcome.cleared) {
      recordAudit({
        action: 'dhcp_handover_completed',
        entityType: 'instance',
        entityId: req.member.id,
        source: 'sync',
        details: { from: req.member.name, leases: outcome.body.synced },
      });
      // The instance DHCP moved to may start; when it is this one, it does now.
      await followDhcp(db);
    }
    res.status(outcome.status).json(outcome.body);
  },
);

// POST /api/sync/leave: a member that could not finish joining takes itself
// off the list, so its row does not hold the change log's deletes back.
router.post('/leave', (req, res) => {
  const db = getDb();
  const state = dhcpState(db);
  // Its leases are the leases: it stays on the list until DHCP is moved.
  if (req.member.instance_id === state.active) {
    return res.status(409).json({
      error: 'This instance serves DHCP. Move DHCP to another instance first.',
      code: 'dhcp_active',
    });
  }
  removeMember(db, req.member.id);
  // It owed its last leases: nobody will send them now, so the new one starts.
  if (req.member.instance_id === state.handoverFrom) {
    clearHandover(db);
    dhcpStateChanged(db);
  }
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
