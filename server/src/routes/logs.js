import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import path from 'path';

const router = Router();

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
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
 * GET /api/logs/stream?filter=all|dns|dhcp&token=<jwt>
 * SSE endpoint that tails the dnsmasq log file.
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

  // Send last 200 lines as initial backlog (use sudo cat since log is owned by dnsmasq)
  try {
    const content = execFileSync('sudo', ['cat', LOG_FILE], { encoding: 'utf-8', timeout: 5000 });
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

  // Tail the log file for new lines (use sudo since log is owned by dnsmasq)
  const tail = spawn('sudo', ['tail', '-n', '0', '-F', LOG_FILE]);

  tail.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (matchesFilter(line, filter)) {
        res.write(`data: ${line}\n\n`);
      }
    }
  });

  tail.on('error', () => {
    res.write('event: error\ndata: tail process failed\n\n');
  });

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    tail.kill();
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
    // Truncate by writing empty string via tee
    execFileSync('sudo', ['tee', LOG_FILE], { input: '', timeout: 5000 });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear log file' });
  }
});

export default router;
