import { Router } from 'express';
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/init.js';
import { queryRaw } from '../db/duckdb.js';
import { APP_VERSION } from '../utils/version.js';
import { isDnsmasqRunning } from '../utils/dnsmasq.js';
import { requirePerm } from '../auth/require-perm.js';
import { getCapabilityWarning, readProcessCapabilities } from '../utils/capabilities.js';
import { getBootServiceHealth } from '../utils/service-health.js';

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

function getSystemMemory() {
  const totalMem = os.totalmem();
  let availableMem = os.freemem();

  // On Linux, MemAvailable is a better operational signal than MemFree
  // because it accounts for reclaimable page cache and buffers.
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    if (match) {
      availableMem = Number(match[1]) * 1024;
    }
  } catch { /* non-Linux or unreadable procfs; os.freemem() is the fallback */ }

  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - availableMem);
  return { total: totalMem, used: usedMem, free: freeMem, available: availableMem };
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

// Restrict /deep to localhost only — exposes subsystem details useful for pre-flight probes
function requireLocalhost(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ status: 'error', message: 'localhost only' });
  next();
}

// GET /api/health/deep — deep health check for pre-flight validation
// Verifies every critical subsystem: SQLite, DuckDB, bcrypt, schema version, fs paths
// Used by update.sh to validate a new version before switching to it.
// Returns 200 only if ALL checks pass. Returns 503 with per-subsystem details otherwise.
router.get('/deep', requireLocalhost, async (req, res) => {
  const checks = {};
  let allOk = true;

  // SQLite — open + query + schema version
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    checks.sqlite = { ok: true, schema_version: row?.v ?? 0 };
  } catch (err) {
    checks.sqlite = { ok: false, error: err.message };
    allOk = false;
  }

  // DuckDB — query analytics DB
  try {
    const rows = await queryRaw('SELECT 1 AS ok');
    checks.duckdb = { ok: Array.isArray(rows) && rows.length > 0 };
    if (!checks.duckdb.ok) allOk = false;
  } catch (err) {
    checks.duckdb = { ok: false, error: err.message };
    allOk = false;
  }

  // bcrypt — module loads and runs a minimal operation
  try {
    const hash = await bcrypt.hash('x', 4);
    checks.bcrypt = { ok: typeof hash === 'string' && hash.startsWith('$2') };
    if (!checks.bcrypt.ok) allOk = false;
  } catch (err) {
    checks.bcrypt = { ok: false, error: err.message };
    allOk = false;
  }

  // ICMP fallback — scanner uses system ping via execFile, not a shell.
  try {
    execFileSync('ping', ['-c', '1', '-W', '1', '127.0.0.1'], { stdio: 'pipe', timeout: 2000 });
    checks.ping = { ok: true };
  } catch (err) {
    const detail = `${err.message || ''}\n${err.stderr?.toString?.() || ''}`;
    const missingCapability = /CAP_NET_RAW|Operation not permitted|missing cap_net_raw/i.test(detail);
    checks.ping = missingCapability
      ? { ok: false, warning: 'ICMP ping requires CAP_NET_RAW; active scans may rely on ARP/passive liveness only.', error: err.message }
      : { ok: false, error: err.message };
    if (!missingCapability) allOk = false;
  }

  // Service capability inheritance. This is warning-only: CIDRella can still
  // run DNS/DHCP/passive liveness without active ARP/ICMP scan support.
  try {
    const caps = readProcessCapabilities();
    const warning = getCapabilityWarning(caps);
    checks.capabilities = { ok: !warning, warning: warning || null, ...caps };
  } catch (err) {
    checks.capabilities = { ok: false, warning: `Unable to inspect process capabilities: ${err.message}` };
  }

  const status = allOk ? 'ok' : 'error';
  res.status(allOk ? 200 : 503).json({
    status,
    version: APP_VERSION,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/health/system — detailed system metrics (authenticated)
router.get('/system', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();

  // CPU
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;

  // Memory
  const memory = getSystemMemory();

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
    memory,
    disk,
    uptime: { system: systemUptime, process: processUptime },
    services: { dnsmasq: dnsmasqRunning },
    service: getBootServiceHealth(),
    stats,
    timestamp: new Date().toISOString()
  });
});

export default router;
