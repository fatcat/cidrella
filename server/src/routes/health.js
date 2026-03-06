import { Router } from 'express';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { getDb } from '../db/init.js';

const router = Router();

// GET /api/health — basic health check (unauthenticated)
router.get('/', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// GET /api/health/system — detailed system metrics (authenticated)
router.get('/system', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const db = getDb();

  // CPU
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage for /data
  let disk = { total: 0, used: 0, available: 0, percent: 0 };
  try {
    const dfOutput = execSync('df -B1 /data 2>/dev/null || df -B1 / 2>/dev/null', { encoding: 'utf-8' });
    const lines = dfOutput.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      disk = {
        total: parseInt(parts[1], 10) || 0,
        used: parseInt(parts[2], 10) || 0,
        available: parseInt(parts[3], 10) || 0,
        percent: parseInt(parts[4], 10) || 0
      };
    }
  } catch { /* ignore */ }

  // Services
  let dnsmasqRunning = false;
  try {
    execSync('pidof dnsmasq', { stdio: 'ignore' });
    dnsmasqRunning = true;
  } catch { /* not running */ }

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

  // DNS resolution check — test each configured upstream server
  let dnsServers = [];
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();
    if (row?.value) dnsServers = JSON.parse(row.value);
  } catch { /* ignore */ }

  const dnsResults = [];
  const testDomain = 'dns-check.example.com';  // any domain; we just care if the server responds
  for (const server of dnsServers) {
    try {
      // Use dig to query each server with a short timeout
      execFileSync('dig', ['+short', '+time=2', '+tries=1', `@${server}`, 'example.com'], {
        timeout: 4000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
      });
      dnsResults.push({ server, status: 'up' });
    } catch {
      dnsResults.push({ server, status: 'down' });
    }
  }

  // Also test system-level resolution (what the app itself uses for hostname options)
  let systemResolution = false;
  try {
    const out = execFileSync('getent', ['ahostsv4', 'example.com'], {
      timeout: 4000, encoding: 'utf-8'
    });
    systemResolution = out.trim().length > 0;
  } catch { /* failed */ }

  res.json({
    cpu: { loadAvg, cores: cpuCount },
    memory: { total: totalMem, used: usedMem, free: freeMem },
    disk,
    uptime: { system: systemUptime, process: processUptime },
    services: { dnsmasq: dnsmasqRunning },
    dns: {
      servers: dnsResults,
      systemResolution,
      ok: systemResolution && dnsResults.length > 0 && dnsResults.some(d => d.status === 'up')
    },
    stats,
    timestamp: new Date().toISOString()
  });
});

export default router;
