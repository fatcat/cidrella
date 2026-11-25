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
import fs from 'fs';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';
import { getDb } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { queueRegen } from '../utils/after-commit.js';
import { runDbTask } from '../utils/db-worker/index.js';
import { recordAudit } from '../services/audit.js';
import { exportChanges, needsSnapshot, spoolFile } from '../sync/changes.js';
import { syncDirOf } from '../sync/credential.js';
import { syncHead, syncStatus } from '../sync/log.js';
import { instanceMode, isFenced, isMember } from '../sync/mode.js';
import { epochBase } from '../sync/promotion-state.js';
import { EPOCH_HEADER, MODE_HEADER, SERVICES_HEADER } from '../sync/controller-call.js';
import { fenceSelf, receiveFence, receiveHandoverDone } from '../services/controller-promotion.js';
import { takeOutboxRows } from '../sync/outbox-intake.js';
import { restoreUnderWay } from '../sync/restore.js';
import {
  controllerOnly,
  epochGate,
  fromOwnController,
  requireListed,
  requireMember,
} from '../sync/require-member.js';
import {
  LOG_PURPOSE,
  LOG_ROLES,
  logFor,
  logSources,
  noLog,
  readBacklog,
  readSince,
  roleFilter,
} from '../utils/log-source.js';
import { acceptLeaseReport } from '../sync/lease-intake.js';
import {
  LEASE_REPORT_TYPE,
  MAX_REPORT_BYTES,
  NOT_DHCP_ACTIVE,
  unpackReport,
} from '../sync/lease-wire.js';
import { followDhcp } from '../services/dhcp-follow.js';
import { clearHandover, dhcpState, dhcpStateChanged, servesDhcpHere } from '../sync/dhcp-active.js';
import {
  formatInstanceStates,
  instanceStates,
  memberHeardFrom,
  parseServiceStates,
} from '../services/instance-services.js';
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

// The fencing rule goes by a credential. A caller known by its sync identity
// alone (a controller that was replaced, asking who the controller is) has
// no say in who the controller is.
const fencingByCredential = (req, res, next) =>
  req.member ? fencingOnController(req, res, next) : next();

// Said on every answer to hello, to a caller this box does not know too
// (MODE_HEADER in sync/controller-call.js).
function sayMode(req, res, next) {
  const db = getDb();
  res.set(MODE_HEADER, isFenced(db) ? 'fenced' : instanceMode());
  res.set(EPOCH_HEADER, String(syncStatus(db).epoch));
  next();
}

/**
 * GET /api/sync/hello: who this instance is and whether it is the controller,
 * `{ instance_id, name, mode, epoch, dataset, dhcp }` with `mode` one of
 * 'controller', 'member' or 'fenced'. `dhcp` is which instance serves DHCP as
 * this box's copy has it (sync/dhcp-active.js): `{ active_instance_id, term,
 * here, handover_from, handover_since }`, `here` whether this box answers
 * DHCP now. An instance about to take over as the controller reads it, since
 * its own copy may be behind. Answered in every mode, to a caller that
 * presents a credential of this estate (requireMember says how a member
 * checks one) or proves it is an instance on the list (requireListed). Any
 * other caller is refused, and told the mode and the epoch in headers.
 */
router.get('/hello', sayMode, requireListed, fencingByCredential, (req, res) => {
  const db = getDb();
  const status = syncStatus(db);
  const dhcp = dhcpState(db);
  res.json({
    instance_id: ownInstanceId(db),
    name: ownInstanceName(db),
    mode: isFenced(db) ? 'fenced' : instanceMode(),
    epoch: status.epoch,
    dataset: status.dataset,
    dhcp: {
      active_instance_id: dhcp.active,
      term: dhcp.term,
      here: servesDhcpHere(db),
      handover_from: dhcp.handoverFrom,
      handover_since: dhcp.handoverSince,
    },
  });
});

const notice = (body) => ({
  epoch: Number(body?.epoch),
  base: Number(body?.base),
  credential: body?.credential,
});

// POST /api/sync/fence { epoch }: a member took over without this
// controller's help and says so. Recorded by receiveFence.
// From a member by its credential, or from an instance on the list that proves
// which one it is (a replaced controller that took the role back holds no
// credential of this box's).
router.post('/fence', requireListed, (req, res) => {
  const outcome = receiveFence(getDb(), req.member || req.listed, notice(req.body).epoch);
  res.status(outcome.status).json(outcome.body);
});

// POST /api/sync/handover-done { epoch, base, credential }: the member this
// controller handed over to has taken over, and gives it the credential to
// follow with. Recorded by receiveHandoverDone.
router.post('/handover-done', requireMember, (req, res) => {
  const outcome = receiveHandoverDone(getDb(), req.member, notice(req.body));
  res.status(outcome.status).json(outcome.body);
});

// The controller reading this member's DNS and DHCP daemon logs for its Logs
// page (routes/logs.js). Short requests: the controller polls with the offset
// it was last given, so no stream stays open between instances.
// What one answer carries at most; the controller asks again for the rest.
const LOG_READ_BYTES = 256 * 1024;
const readsLogs = fromOwnController(LOG_PURPOSE);

// GET /api/sync/logs/sources: what /api/logs/sources says, nothing clearable.
router.get('/logs/sources', readsLogs, (req, res) => {
  res.json(logSources({ clearable: false }));
});

// GET /api/sync/logs?role=dns|dhcp[&after=<offset>]: without `after`, the
// last lines of the role's log; with it, the complete lines written since.
// Either way `{ lines, offset }`, `offset` the place to ask from next.
router.get('/logs', readsLogs, (req, res) => {
  const role = req.query.role || 'dns';
  if (!LOG_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be dns or dhcp', code: 'bad_request' });
  }
  const log = logFor(role);
  if (!log) return res.status(404).json({ ...noLog(role), code: 'no_log' });
  const filter = roleFilter(log, role);
  if (req.query.after === undefined) return res.json(readBacklog(log, filter));
  const after = Number(req.query.after);
  if (!Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ error: 'after must be a byte offset', code: 'bad_request' });
  }
  res.json(readSince(log, after, filter, LOG_READ_BYTES));
});

router.use(controllerOnly);

const isUuid = (value) => /^[0-9a-f-]{36}$/.test(String(value || ''));
const isFingerprint = (value) => /^[0-9a-f]{64}$/.test(String(value || ''));
// A count a member sent (dif): a small whole number, or null when absent or not one.
const interfaceCountParam = (value) =>
  typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : null;

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
  // Once a restore has swapped the files the database stays closed until the
  // restart: no token can be read, and none made before it survives.
  if (restoreUnderWay(db) && !db.open) return refuseWhileRestoring(res);
  // The token first: nothing is told to a caller without one. It is used up
  // with the member's row or not at all, so another schema or a restore
  // leaves it good.
  const mismatch = Symbol('schema');
  const restoring = Symbol('restoring');
  let credential;
  try {
    credential = db.transaction(() => {
      if (!redeemJoinToken(db, token)) return null;
      if (schema !== syncStatus(db).schema) throw mismatch;
      // The restore has read the instance list or is about to: a member
      // added now would be missing from the restored one (sync/restore.js).
      if (restoreUnderWay(db)) throw restoring;
      return addJoiningMember();
    })();
  } catch (err) {
    if (err === restoring) return refuseWhileRestoring(res);
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

// The join screen shows the error as is (sync/member.js joinController).
function refuseWhileRestoring(res) {
  return res.status(503).json({
    error:
      'This CIDRella is restoring a backup. Wait for it to restart, make a new join token there, then join.',
    code: 'restoring',
  });
}

// Everything below is a member's, by its credential, and subject to the
// fencing rule.
router.use(requireMember, fencing);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /api/sync/changes?dataset=&epoch=&from=&since=&schema=&version=&wait=
 * What the member is missing, gzip, as sync/changes.js writes it. With `wait`
 * and nothing to send, holds the request until something changes or the wait
 * runs out (204).
 *
 * `epoch` is the epoch the member's copy is from and `from` the instance
 * whose log it was taken from. A cursor means the same thing here only in
 * two cases: the copy is of this controller's own log at its own epoch, or
 * it is of the log this controller carried on from (`epoch_base`: the
 * controller it took over from, at that controller's epoch) with the cursor
 * no further than where this box took over. Past that point the member holds
 * changes of the old controller that this one never had. An epoch number
 * alone is not enough: two members promoted at once reach the same number
 * with different logs. Any other copy is sent everything.
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
  // A member from before the instance was sent is taken at its epoch's word.
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null;
  const base = epochBase(db);
  const ownLog = lineage === local.epoch && (from === null || from === ownInstanceId(db));
  const carriedOn =
    base !== null &&
    since !== null &&
    since <= base.head &&
    lineage === (base.epoch ?? local.epoch - 1) &&
    (from === null || base.from === null || from === base.from);
  const sameLine = ownLog || carriedOn;
  // A cursor counts only where it could be true: it decides which deletes
  // the log may forget.
  const believable = sameLine && dataset === local.dataset && since !== null && since <= local.head;
  noteContact(db, req.member.id, {
    cursor: believable ? since : null,
    version,
    schema,
    services: parseServiceStates(req.query.svc),
    // Kept only when it is a DUID (noteContact normalizes it).
    duid: typeof req.query.duid === 'string' ? req.query.duid.slice(0, 400) : null,
    dhcpInterfaces: interfaceCountParam(req.query.dif),
  });
  // Out of contact a while ago: DHCP clients are given it again.
  memberHeardFrom(db, req.member);
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
  }
  // Every answer says what each instance's servers are doing, as of now: a
  // long poll can end well after the request came in.
  res.set(SERVICES_HEADER, formatInstanceStates(await instanceStates(db)));
  if (closed) return;
  if (!snapshot && syncHead(db) === since) return res.status(204).end();
  const asChanges = () =>
    res.set({ 'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip' });
  if (!snapshot) return asChanges().send(zlib.gzipSync(exportChanges(db, { dataset, since })));

  // A snapshot reads every row: off the event loop, on a connection of its
  // own, into a file a piece at a time, which goes out compressed as it is
  // read (zlib works on the thread pool). Nothing holds the whole dataset.
  // No cursor is passed: the export decides between a snapshot and a delta
  // by it, and this one is a snapshot.
  const file = spoolFile(syncDirOf(db));
  try {
    await runDbTask('syncExport', { dbPath: db.name, dataset: null, since: null, file });
    if (closed) return;
    asChanges();
    await pipeline(fs.createReadStream(file), zlib.createGzip(), res).catch((err) => {
      // The response is cut short, which the member reads as a lost connection.
      if (!closed) console.warn(`[sync] could not send a snapshot: ${err.message}`);
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
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
 * app's JSON parser, which leaves this content type alone, and only once
 * leaseGate has let the caller through.
 */
const unpacking = new Set();

// Ahead of the body: only the instance whose leases could count is read at
// all, and one report of its at a time. A body is up to MAX_REPORT_BYTES in
// memory and unpacking is the costly part, so neither is spent on a member
// that does not serve DHCP or on a second report while the first is in hand.
function leaseGate(req, res, next) {
  const db = getDb();
  noteContact(db, req.member.id);
  const state = dhcpState(db);
  const mine = req.member.instance_id;
  if ((mine !== state.active && mine !== state.handoverFrom) || unpacking.has(mine)) {
    // The body is let go by as it arrives, kept nowhere, and the answer
    // follows it: an answer sent while the member is still writing would
    // reach it as a broken connection.
    req.on('end', () =>
      res.status(409).json({ error: 'This instance does not serve DHCP.', code: NOT_DHCP_ACTIVE }),
    );
    req.resume();
    return;
  }
  unpacking.add(mine);
  // Answered, or the member gave up midway: either way its next report may come.
  res.once('close', () => unpacking.delete(mine));
  next();
}

router.post(
  '/leases',
  leaseGate,
  express.raw({ type: LEASE_REPORT_TYPE, limit: MAX_REPORT_BYTES }),
  async (req, res) => {
    const db = getDb();
    const report = await unpackReport(req.body);
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
