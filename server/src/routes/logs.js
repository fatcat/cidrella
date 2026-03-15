import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/defaults.js';

const router = Router();
const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

// DHCP log patterns
const DHCP_PATTERNS = [
  'DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK',
  'DHCPNAK', 'DHCPRELEASE', 'DHCPINFORM', 'DHCPDECLINE',
  'available DHCP'
];

const DHCP_RE = new RegExp(DHCP_PATTERNS.join('|'), 'i');

function isDhcpLine(line) {
  return DHCP_RE.test(line);
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

  // File was truncated (e.g. clear) — reset
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
 * GET /api/logs/stream?filter=all|dns|dhcp&token=<jwt>
 * SSE endpoint that watches the dnsmasq log file.
 */
router.get('/stream', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const filter = req.query.filter || 'all';

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

  // Send last 200 lines as initial backlog
  let offset = 0;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    offset = Buffer.byteLength(content, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
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
    res.write('event: error\ndata: watch failed\n\n');
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
router.post('/clear', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    fs.writeFileSync(LOG_FILE, '');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear log file' });
  }
});

export default router;
