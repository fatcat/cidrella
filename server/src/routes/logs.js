import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { recordAudit } from '../services/audit.js';
import { getDb } from '../db/init.js';
import { ownInstanceName, reachableMembers } from '../models/sync-instance.js';
import { callMemberAsController, jsonBody } from '../sync/controller-call.js';
import { readSyncState } from '../sync/log.js';
import { isMember } from '../sync/mode.js';
import {
  LOG_PURPOSE,
  LOG_ROLES,
  ensureLogFile,
  logFor,
  logSources,
  noLog,
  readBacklog,
  readSince,
  roleFilter,
} from '../utils/log-source.js';

const router = Router();

// How often the controller asks a member for what its log gained, and how
// long one ask may take.
const MEMBER_POLL_MS = 2000;
const MEMBER_CALL_MS = 10_000;
// One answer from a member: 256 KB of lines (routes/sync.js) and JSON around them.
const MEMBER_MAX_BYTES = 2 * 1024 * 1024;

// Short-lived SSE stream tickets, key: token string, value: expiry timestamp
const streamTickets = new Map();
const TICKET_TTL_MS = 30_000; // 30 seconds

// Periodically purge expired tickets
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of streamTickets) {
    if (now > expiry) streamTickets.delete(token);
  }
}, 60_000);

/**
 * The members whose logs the controller can show: every joined one, with the
 * address it is called at. None on a member or a single box.
 */
const logMembers = (db) => (isMember(db) ? [] : reachableMembers(db));

/** The instances a viewer may pick from, this box first. Empty with no members. */
function logInstances(db) {
  const members = logMembers(db);
  if (!members.length) return [];
  return [
    { instance_id: readSyncState(db, 'instance_id'), name: ownInstanceName(db) },
    ...members.map(({ instance_id, name }) => ({ instance_id, name })),
  ];
}

/**
 * The member `?instance=` names, `null` for this box (no instance, or its
 * own), or `undefined` for an instance this box cannot read a log of.
 */
function requestedMember(db, req) {
  const id = req.query.instance;
  if (!id) return null;
  if (typeof id !== 'string') return undefined;
  const member = logMembers(db).find((row) => row.instance_id === id);
  if (member) return member;
  return id === readSyncState(db, 'instance_id') ? null : undefined;
}

const unknownInstance = (res) =>
  res.status(404).json({ error: 'No instance by that id has a log to show here' });

// One log line as an SSE message. A line holds no newline; a carriage return
// would end the field early, so it goes too.
const sseLine = (line) => `data: ${line.replace(/\r/g, '')}\n\n`;

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: ok\n\n');
}

/** Keepalive every 30 s; `stop` called once the browser goes. */
function keepAlive(req, res, stop) {
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);
  req.on('close', () => {
    clearInterval(keepalive);
    stop();
  });
}

/**
 * POST /api/logs/stream-token
 * Issues a short-lived ticket (30s) that can be used as ?ticket= on the SSE stream.
 * Requires authentication, this lets EventSource (which can't set headers) authenticate.
 */
router.post('/stream-token', requirePerm('dns:read'), (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  streamTickets.set(token, Date.now() + TICKET_TTL_MS);
  res.json({ ticket: token, ttl: TICKET_TTL_MS });
});

/**
 * GET /api/logs/sources[?instance=<instance_id>]
 * `{ sources, instances }`. `sources` has one entry per role: the backend
 * filling it, whether it keeps a log to show (and why not), and whether the
 * log may be cleared. The viewer builds its tabs from these. With `instance`
 * naming a member, they are that member's, asked of it, and none is
 * clearable here. `instances` is what a controller with members may show,
 * this box first; empty on a single box and on a member.
 */
router.get('/sources', requirePerm('dns:read'), async (req, res) => {
  const db = getDb();
  const member = requestedMember(db, req);
  if (member === undefined) return unknownInstance(res);
  const instances = logInstances(db);
  if (!member) return res.json({ sources: logSources(), instances });
  try {
    const response = await callMemberAsController(db, member, LOG_PURPOSE, {
      path: '/api/sync/logs/sources',
      timeoutMs: MEMBER_CALL_MS,
      maxBytes: MEMBER_MAX_BYTES,
    });
    const body = jsonBody(response);
    if (response.status !== 200 || !Array.isArray(body)) {
      return res.status(502).json({
        error: `${member.name} would not say which logs it keeps: ${body.error || `HTTP ${response.status}`}`,
      });
    }
    res.json({ sources: body.map((entry) => ({ ...entry, clearable: false })), instances });
  } catch (err) {
    res.status(502).json({ error: `${member.name} did not answer: ${err.message}` });
  }
});

/** The local log of `role` to the browser: its tail, then what is written to it. */
function streamLocal(req, res, log, filter) {
  try {
    ensureLogFile(log.file);
  } catch {
    // Keep the SSE connection usable even if the runtime log path cannot be
    // created. The stream will stay open and report an empty backlog.
  }
  sseHeaders(res);
  const backlog = readBacklog(log, filter);
  for (const line of backlog.lines) res.write(sseLine(line));
  res.write('event: backlog-end\ndata: ok\n\n');

  let offset = backlog.offset;
  let watcher;
  try {
    watcher = fs.watch(log.file, () => {
      const since = readSince(log, offset, filter);
      offset = since.offset;
      for (const line of since.lines) res.write(sseLine(line));
    });
  } catch {
    res.write('event: watch-status\ndata: unavailable\n\n');
  }
  keepAlive(req, res, () => watcher?.close());
}

/**
 * A member's log of `role` to the browser, as streamLocal sends one: its
 * tail, then what is written to it, asked of the member every
 * MEMBER_POLL_MS with the offset it last gave (GET /api/sync/logs). While it
 * does not answer the browser is told `unreachable`, and `live` once it does
 * again; the asking goes on until the browser goes.
 */
function streamMember(req, res, db, member, role) {
  sseHeaders(res);
  let offset = null;
  let closed = false;
  let timer = null;
  let reachable = true;
  const say = (status) => res.write(`event: watch-status\ndata: ${status}\n\n`);

  async function poll() {
    const query = new URLSearchParams({ role });
    if (offset !== null) query.set('after', String(offset));
    try {
      const response = await callMemberAsController(db, member, LOG_PURPOSE, {
        path: `/api/sync/logs?${query}`,
        timeoutMs: MEMBER_CALL_MS,
        maxBytes: MEMBER_MAX_BYTES,
      });
      if (closed) return;
      const body = jsonBody(response);
      if (response.status !== 200 || !Array.isArray(body.lines)) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (!reachable) say('live');
      reachable = true;
      for (const line of body.lines) {
        if (typeof line === 'string') res.write(sseLine(line));
      }
      if (offset === null) res.write('event: backlog-end\ndata: ok\n\n');
      if (Number.isSafeInteger(body.offset) && body.offset >= 0) offset = body.offset;
    } catch {
      if (closed) return;
      if (reachable) say('unreachable');
      reachable = false;
    } finally {
      if (!closed) timer = setTimeout(poll, MEMBER_POLL_MS);
    }
  }

  keepAlive(req, res, () => {
    closed = true;
    clearTimeout(timer);
  });
  void poll();
}

/**
 * GET /api/logs/stream?role=dns|dhcp&filter=all|dns|dhcp&instance=<instance_id>&ticket=<one-time-token>
 * SSE endpoint that watches the log of the backend filling `role` (default
 * dns), on this box or on the member `instance` names. Without a role,
 * `filter` picks lines from the DNS backend's log as before; with one, the
 * role's lines are kept where one log serves both.
 * Auth via JWT (req.user set by authMiddleware) OR a valid ?ticket= param.
 */
router.get('/stream', (req, res) => {
  // Accept a short-lived ticket as an alternative to the JWT (EventSource can't set headers)
  const ticket = req.query.ticket;
  if (ticket) {
    const expiry = streamTickets.get(ticket);
    if (!expiry || Date.now() > expiry) {
      return res.status(401).json({ error: 'Invalid or expired stream ticket' });
    }
    // Consume the ticket, single use
    streamTickets.delete(ticket);
  } else if (!req.user || !req.user.role) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const role = req.query.role || 'dns';
  if (!LOG_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be dns or dhcp' });
  }
  const db = getDb();
  const member = requestedMember(db, req);
  if (member === undefined) return unknownInstance(res);
  if (member) return streamMember(req, res, db, member, role);

  const log = logFor(role);
  if (!log) return res.status(404).json(noLog(role));
  const filter = req.query.role ? roleFilter(log, role) : req.query.filter || 'all';
  streamLocal(req, res, log, filter);
});

/**
 * POST /api/logs/clear?role=dns|dhcp
 * Truncate the log of the backend filling `role` (default dns). An audit
 * log (Kea's legal log) is kept for the audit retention, never cleared here.
 * A member's log is cleared on the member.
 */
router.post('/clear', requireRole('admin'), (req, res) => {
  if (req.query.instance) {
    const db = getDb();
    const member = requestedMember(db, req);
    if (member === undefined) return unknownInstance(res);
    if (member) {
      return res.status(409).json({ error: `Clear this log on ${member.name}` });
    }
  }
  const role = req.query.role || 'dns';
  if (!LOG_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be dns or dhcp' });
  }
  const log = logFor(role);
  if (!log) return res.status(404).json(noLog(role));
  if (log.source.clearable === false) {
    return res.status(409).json({ error: `${log.label} keeps this log as an audit trail` });
  }
  try {
    let bytes = 0;
    try {
      bytes = fs.statSync(log.file).size;
    } catch {
      // A log not written yet has nothing to clear.
    }
    // Recorded first: a log cleared with no record of it is the worse outcome.
    recordAudit({
      action: 'log_cleared',
      entityType: 'log',
      details: { role, file: path.basename(log.file), bytes },
    });
    fs.writeFileSync(log.file, '');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear log file' });
  }
});

export default router;
