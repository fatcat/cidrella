import { Router } from 'express';
import os from 'os';
import { execFileSync } from 'child_process';
import { getDb } from '../db/init.js';
import { APP_VERSION } from '../utils/version.js';
import { isDnsmasqRunning } from '../utils/dnsmasq.js';
import { requirePerm } from '../auth/require-perm.js';

const router = Router();

function parseDf(target) {
  const dfOutput = execFileSync('df', ['-B1', target], { encoding: 'utf-8' });
  const lines = dfOutput.trim().split('\n');
  if (lines.length >= 2) {
    const parts = lines[1].split(/\s+/);
    return {
      total: parseInt(parts[1], 10) || 0,
      used: parseInt(parts[2], 10) || 0,
      available: parseInt(parts[3], 10) || 0,
      percent: parseInt(parts[4], 10) || 0
    };
  }
  return { total: 0, used: 0, available: 0, percent: 0 };
}

// GET /api/health — basic health check (unauthenticated)
router.get('/', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', version: APP_VERSION, timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// GET /api/health/system — detailed system metrics (authenticated)
router.get('/system', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();

  // CPU
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage for data directory
  const dataDir = process.env.DATA_DIR || '/data';
  let disk = { total: 0, used: 0, available: 0, percent: 0 };
  try { disk = parseDf(dataDir); } catch {
    try { disk = parseDf('/'); } catch { /* ignore */ }
  }

  // Services
  const dnsmasqRunning = isDnsmasqRunning();

  // Uptime
  const systemUptime = os.uptime();
  const processUptime = process.uptime();

  // DB stats
  const stats = {};
  try {
    stats.subnets = db.prepare("SELECT COUNT(*) as c FROM subnets WHERE status = 'allocated'").get().c;
    stats.dns_zones = db.prepare('SELECT COUNT(*) as c FROM dns_zones').get().c;
    stats.dns_records = db.prepare('SELECT COUNT(*) as c FROM dns_records').get().c;
    stats.dhcp_scopes = db.prepare('SELECT COUNT(*) as c FROM dhcp_scopes WHERE enabled = 1').get().c;
    stats.dhcp_leases = db.prepare('SELECT COUNT(*) as c FROM dhcp_leases').get().c;
    stats.dhcp_reservations = db.prepare('SELECT COUNT(*) as c FROM dhcp_reservations').get().c;
    stats.audit_entries = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  } catch { /* tables may not exist yet */ }

  res.json({
    version: APP_VERSION,
    cpu: { loadAvg, cores: cpuCount },
    memory: { total: totalMem, used: usedMem, free: freeMem },
    disk,
    uptime: { system: systemUptime, process: processUptime },
    services: { dnsmasq: dnsmasqRunning },
    stats,
    timestamp: new Date().toISOString()
  });
});

export default router;
