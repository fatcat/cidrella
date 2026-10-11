import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { getService } from '../backends/index.js';

const router = Router();
const ROLES = ['dns', 'dhcp'];

/**
 * The log to show for `role` (dns or dhcp, default dns), asked of the
 * backend filling it now, so a stack switch moves the viewer with it.
 * `filter` keeps the role's lines when one log serves both (dnsmasq).
 * null when the backend keeps no log.
 */
function logFor(role) {
  const service = getService(role);
  const source = service.logSource();
  const file = source?.path ?? null;
  if (!file) return null;
  const shared = getService('dns') === getService('dhcp');
  return { source, file, label: service.label || service.name, shared };
}

function noLog(role) {
  const service = getService(role);
  return {
    error: `${service.label || service.name} keeps no ${role.toUpperCase()} log to show`,
  };
}

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

function ensureLogFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Append nothing: creates the file if missing without truncating one that
  // dnsmasq created (and started writing) between a check and a write.
  fs.writeFileSync(file, '', { flag: 'a' });
}

function matchesFilter(source, line, filter) {
  if (filter === 'all') return true;
  const isDhcp = source.isDhcpLine(line);
  if (filter === 'dhcp') return isDhcp;
  if (filter === 'dns') return !isDhcp;
  return true;
}

/**
 * Read new bytes appended to the log file since the given offset.
 * Returns { lines, newOffset }. Handles truncation (reset to 0).
 */
function readNewLines(file, offset) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], newOffset: 0 };
  }

  // File was truncated (e.g. clear), reset
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [], newOffset: offset };

  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter((l) => l.trim());
  return { lines, newOffset: size };
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
 * GET /api/logs/sources
 * One entry per role: the backend filling it, whether it keeps a log to show
 * (and why not), and whether the log may be cleared. The viewer builds its
 * tabs from this.
 */
router.get('/sources', requirePerm('dns:read'), (req, res) => {
  res.json(
    ROLES.map((role) => {
      const service = getService(role);
      const log = logFor(role);
      return {
        role,
        label: service.label || service.name,
        available: Boolean(log),
        clearable: Boolean(log) && log.source.clearable !== false,
        message: log ? null : noLog(role).error,
      };
    }),
  );
});

/**
 * GET /api/logs/stream?role=dns|dhcp&filter=all|dns|dhcp&ticket=<one-time-token>
 * SSE endpoint that watches the log of the backend filling `role` (default
 * dns). Without a role, `filter` picks lines from the DNS backend's log as
 * before; with one, the role's lines are kept where one log serves both.
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
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'role must be dns or dhcp' });
  const log = logFor(role);
  if (!log) return res.status(404).json(noLog(role));
  const { source, file } = log;
  const filter = req.query.role ? (log.shared ? role : 'all') : req.query.filter || 'all';

  try {
    ensureLogFile(file);
  } catch {
    // Keep the SSE connection usable even if the runtime log path cannot be
    // created. The stream will stay open and report an empty backlog.
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send initial connected event
  res.write('event: connected\ndata: ok\n\n');

  // Send last 200 lines as initial backlog.
  //
  // CRITICAL: read only the TAIL of the log file, never the whole thing.
  // dnsmasq.log on long-running installs without log rotation can be
  // 1+ GB. The previous version did `fs.readFileSync(LOG_FILE, 'utf-8')`
  // which allocated the entire file into a Buffer, then a String, then a
  // 15M-element Array, V8 attempted ~3 GB of heap and the cidrella service
  // OOM-killed itself every time anyone opened the Logging tab. Read a
  // bounded tail instead. 64 KB comfortably holds ~200 lines of dnsmasq
  // output (~150-200 bytes/line) with headroom.
  let offset = 0;
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const tailBytes = Math.min(64 * 1024, size);
    const tailStart = size - tailBytes;
    const buf = Buffer.alloc(tailBytes);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, tailBytes, tailStart);
    } finally {
      fs.closeSync(fd);
    }
    offset = size; // resume incremental tail from EOF, no double-reads
    const text = buf.toString('utf-8');
    // If we didn't start the read at a newline boundary, the first
    // partial line is unusable, drop it. Skip this trim only when we
    // happened to read the entire file (tailStart === 0).
    const firstNewline = text.indexOf('\n');
    const usable = tailStart > 0 && firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    const lines = usable.split('\n').filter((l) => l.trim());
    const backlog = lines.slice(-200);
    for (const line of backlog) {
      if (matchesFilter(source, line, filter)) {
        res.write(`data: ${line}\n\n`);
      }
    }
    res.write('event: backlog-end\ndata: ok\n\n');
  } catch {
    res.write('event: backlog-end\ndata: ok\n\n');
  }

  // Watch the log file for new writes
  let watcher;
  try {
    watcher = fs.watch(file, () => {
      const { lines, newOffset } = readNewLines(file, offset);
      offset = newOffset;
      for (const line of lines) {
        if (matchesFilter(source, line, filter)) {
          res.write(`data: ${line}\n\n`);
        }
      }
    });
  } catch {
    res.write('event: watch-status\ndata: unavailable\n\n');
  }

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    if (watcher) watcher.close();
  });
});

/**
 * POST /api/logs/clear?role=dns|dhcp
 * Truncate the log of the backend filling `role` (default dns). An audit
 * log (Kea's legal log) is kept for the audit retention, never cleared here.
 */
router.post('/clear', requireRole('admin'), (req, res) => {
  const role = req.query.role || 'dns';
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'role must be dns or dhcp' });
  const log = logFor(role);
  if (!log) return res.status(404).json(noLog(role));
  if (log.source.clearable === false) {
    return res.status(409).json({ error: `${log.label} keeps this log as an audit trail` });
  }
  try {
    fs.writeFileSync(log.file, '');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear log file' });
  }
});

export default router;
