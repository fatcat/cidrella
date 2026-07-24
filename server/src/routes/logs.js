import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '../config/defaults.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';

const router = Router();
const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

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

const DHCP_RE = /\b(?:DHCPDISCOVER|DHCPOFFER|DHCPREQUEST|DHCPACK|DHCPNAK|DHCPRELEASE|DHCPINFORM|DHCPDECLINE)\b|available DHCP|dnsmasq-dhcp\[\d+\]:|\bsent size:\s+\d+\s+option:|\brequested options:|\bnext server:|\bclient provides name:|\bvendor class:|\btags:\s+scope/i;

export function isDhcpLine(line) {
  return DHCP_RE.test(line);
}

function ensureLogFile() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // Append nothing: creates the file if missing without truncating one that
  // dnsmasq created (and started writing) between a check and a write.
  fs.writeFileSync(LOG_FILE, '', { flag: 'a' });
}

function matchesFilter(line, filter) {
  if (filter === 'all') return true;
  const isDhcp = isDhcpLine(line);
  if (filter === 'dhcp') return isDhcp;
  if (filter === 'dns') return !isDhcp;
  return true;
}

/**
 * Read new bytes appended to the log file since the given offset.
 * Returns { lines, newOffset }. Handles truncation (reset to 0).
 */
function readNewLines(offset) {
  let size;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return { lines: [], newOffset: 0 };
  }

  // File was truncated (e.g. clear), reset
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [], newOffset: offset };

  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter(l => l.trim());
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
 * GET /api/logs/stream?filter=all|dns|dhcp&ticket=<one-time-token>
 * SSE endpoint that watches the dnsmasq log file.
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

  const filter = req.query.filter || 'all';

  try {
    ensureLogFile();
  } catch {
    // Keep the SSE connection usable even if the runtime log path cannot be
    // created. The stream will stay open and report an empty backlog.
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
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
    const stat = fs.statSync(LOG_FILE);
    const size = stat.size;
    const tailBytes = Math.min(64 * 1024, size);
    const tailStart = size - tailBytes;
    const buf = Buffer.alloc(tailBytes);
    const fd = fs.openSync(LOG_FILE, 'r');
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
    const usable = (tailStart > 0 && firstNewline >= 0)
      ? text.slice(firstNewline + 1)
      : text;
    const lines = usable.split('\n').filter(l => l.trim());
    const backlog = lines.slice(-200);
    for (const line of backlog) {
      if (matchesFilter(line, filter)) {
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
    watcher = fs.watch(LOG_FILE, () => {
      const { lines, newOffset } = readNewLines(offset);
      offset = newOffset;
      for (const line of lines) {
        if (matchesFilter(line, filter)) {
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
 * POST /api/logs/clear
 * Truncate the log file.
 */
router.post('/clear', requireRole('admin'), (req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear log file' });
  }
});

export default router;
