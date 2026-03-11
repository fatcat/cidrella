import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import os from 'os';
import ping from 'net-ping';
import { parseCidr, longToIp, isIpInSubnet } from './ip.js';
import { ARPING_TIMEOUT_MS, PING_TIMEOUT_MS, SCAN_BATCH_SIZE } from '../config/defaults.js';

/**
 * Run arping on a single IP (Layer 2 — local subnets only).
 * Returns { responded, mac } or { responded: false, mac: null }.
 */
function arpingIp(ip) {
  return new Promise((resolve) => {
    execFile('sudo', ['/usr/sbin/arping', '-c', '1', '-w', '1', ip], { timeout: ARPING_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve({ responded: false, mac: null });
        return;
      }
      const macMatch = stdout.match(/\[([0-9a-fA-F:]+)\]/);
      resolve({
        responded: true,
        mac: macMatch ? macMatch[1].toLowerCase() : null
      });
    });
  });
}

/**
 * ICMP ping using net-ping (raw sockets — no shell, no sudo).
 * Requires CAP_NET_RAW on the node binary or running as root.
 */
function createPingSession() {
  return ping.createSession({
    timeout: PING_TIMEOUT_MS,
    retries: 0,
    packetSize: 16,
  });
}

function pingIp(session, ip) {
  return new Promise((resolve) => {
    session.pingHost(ip, (error) => {
      resolve({ responded: !error, mac: null });
    });
  });
}

/**
 * Read the OS ARP cache from /proc/net/arp.
 * Returns a Map of IP → MAC for all entries with a valid MAC.
 */
async function readArpCache() {
  const arpMap = new Map();
  try {
    const data = await readFile('/proc/net/arp', 'utf8');
    // Format: IP address  HW type  Flags  HW address  Mask  Device
    for (const line of data.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] !== '00:00:00:00:00:00') {
        arpMap.set(parts[0], parts[3].toLowerCase());
      }
    }
  } catch { /* /proc/net/arp may not exist on non-Linux */ }
  return arpMap;
}

/**
 * Check if a subnet is directly connected to one of the host's interfaces.
 */
function isLocalSubnet(cidr) {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (isIpInSubnet(iface.address, cidr)) return true;
      }
    }
  }
  return false;
}

/**
 * Resolve whether an IP should be included in a liveness scan.
 * Inheritance: IP override → Subnet override → Folder default → true
 */
function shouldScanIp(ipOverride, subnetDefault) {
  if (ipOverride !== null && ipOverride !== undefined) return !!ipOverride;
  return subnetDefault;
}

/**
 * Resume any interrupted scans (status = 'running' or 'pending') on startup.
 * Skips IPs that already have scan_results from a previous partial run.
 */
export function resumeInterruptedScans(db) {
  const interrupted = db.prepare(
    "SELECT * FROM network_scans WHERE status IN ('running', 'pending')"
  ).all();

  for (const scan of interrupted) {
    console.log(`[scanner] Resuming interrupted scan #${scan.id} for subnet ${scan.subnet_id} (${scan.scanned_ips}/${scan.total_ips} done)`);
    startScan(db, scan.id, scan.subnet_id);
  }
}

/**
 * Start an async network scan for a subnet.
 * Uses arping (Layer 2) for local subnets, net-ping ICMP (Layer 3) for remote.
 * After ICMP scanning, reads the OS ARP cache to capture MAC addresses.
 * Resumes from where it left off if scan_results already exist for some IPs.
 * Updates the database with progress and results as it goes.
 */
export async function startScan(db, scanId, subnetId) {
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  if (!subnet) {
    db.prepare("UPDATE network_scans SET status = 'failed', error = 'Subnet not found', completed_at = datetime('now') WHERE id = ?").run(scanId);
    return;
  }

  // Resolve scan method based on network locality
  const local = isLocalSubnet(subnet.cidr);
  let icmpSession = null;
  let probeIp;

  if (local) {
    probeIp = (ip) => arpingIp(ip);
  } else {
    try {
      icmpSession = createPingSession();
    } catch (err) {
      db.prepare("UPDATE network_scans SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?")
        .run(`Failed to create ICMP session: ${err.message}`, scanId);
      return;
    }
    probeIp = (ip) => pingIp(icmpSession, ip);
  }

  console.log(`[scanner] Subnet ${subnet.cidr} — using ${local ? 'ARP (arping)' : 'ICMP (net-ping)'} probes`);

  // Resolve subnet-level scan default from inheritance chain (subnet → global setting)
  let subnetDefault = true;
  if (subnet.scan_enabled !== null && subnet.scan_enabled !== undefined) {
    subnetDefault = !!subnet.scan_enabled;
  } else {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'default_scan_enabled'").get();
    subnetDefault = setting ? setting.value === '1' : true;
  }

  // Pre-load per-IP scan_enabled overrides
  const ipOverrides = db.prepare(
    'SELECT ip_address, scan_enabled FROM ip_addresses WHERE subnet_id = ? AND scan_enabled IS NOT NULL'
  ).all(subnetId);
  const overrideMap = new Map(ipOverrides.map(r => [r.ip_address, r.scan_enabled]));

  const parsed = parseCidr(subnet.cidr);
  const startIp = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
  const endIp = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;
  const totalIps = endIp - startIp + 1;

  // Check for already-scanned IPs (resume support)
  const alreadyScanned = new Set(
    db.prepare('SELECT ip_address FROM scan_results WHERE scan_id = ?')
      .all(scanId)
      .map(r => r.ip_address)
  );

  // Load existing counts from partial run
  let scannedCount = alreadyScanned.size;
  let conflictsFound = db.prepare(
    'SELECT COUNT(*) as cnt FROM scan_results WHERE scan_id = ? AND is_conflict = 1'
  ).get(scanId).cnt;

  if (alreadyScanned.size > 0) {
    console.log(`[scanner] Resuming scan #${scanId} — ${alreadyScanned.size} IPs already scanned, continuing from where we left off`);
  }

  // Update scan status to running
  db.prepare("UPDATE network_scans SET status = 'running', total_ips = ?, started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(totalIps, scanId);

  // Get existing IP assignments for conflict detection
  const assignments = db.prepare(`
    SELECT ip_address, mac_address, hostname, status FROM ip_addresses
    WHERE subnet_id = ? AND status != 'available'
  `).all(subnetId);
  const assignmentMap = new Map(assignments.map(a => [a.ip_address, a]));

  const insertResult = db.prepare(`
    INSERT INTO scan_results (scan_id, ip_address, mac_address, responded, is_conflict, conflict_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  try {
    // Scan in batches for reasonable speed
    for (let batchStart = startIp; batchStart <= endIp; batchStart += SCAN_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + SCAN_BATCH_SIZE - 1, endIp);
      const promises = [];

      for (let ipLong = batchStart; ipLong <= batchEnd; ipLong++) {
        const ip = longToIp(ipLong);

        // Skip IPs already scanned in a previous partial run
        if (alreadyScanned.has(ip)) continue;

        // Check scan_enabled for this IP
        const override = overrideMap.get(ip);
        if (!shouldScanIp(override !== undefined ? override : null, subnetDefault)) {
          continue; // skip — scanning disabled for this IP
        }

        promises.push(probeIp(ip).then(result => ({ ip, ...result })));
      }

      if (promises.length === 0) continue;

      const results = await Promise.all(promises);

      // For ICMP scans, read the ARP cache to capture MACs the kernel learned
      let arpCache = null;
      if (!local && results.some(r => r.responded)) {
        arpCache = await readArpCache();
      }

      for (const result of results) {
        // Enrich ICMP results with ARP cache MAC
        if (!local && result.responded && !result.mac && arpCache) {
          result.mac = arpCache.get(result.ip) || null;
        }

        let isConflict = 0;
        let conflictReason = null;
        const assignment = assignmentMap.get(result.ip);

        if (result.responded) {
          if (!assignment) {
            // IP responded but not assigned — rogue device
            isConflict = 1;
            conflictReason = 'Rogue device (IP not assigned)';
          } else if (assignment.mac_address && result.mac &&
                     assignment.mac_address.toLowerCase() !== result.mac) {
            // MAC mismatch
            isConflict = 1;
            conflictReason = `MAC mismatch (expected ${assignment.mac_address}, got ${result.mac})`;
          }
        }

        if (isConflict) conflictsFound++;

        insertResult.run(
          scanId, result.ip, result.mac,
          result.responded ? 1 : 0, isConflict, conflictReason
        );
      }

      scannedCount += results.length;

      // Update progress
      db.prepare("UPDATE network_scans SET scanned_ips = ?, conflicts_found = ? WHERE id = ?")
        .run(scannedCount, conflictsFound, scanId);
    }

    // Update ip_addresses with online/offline status from scan results
    const updateIpOnline = db.prepare(`
      UPDATE ip_addresses SET
        is_online = ?,
        last_seen_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_seen_at END,
        last_seen_mac = CASE WHEN ? IS NOT NULL THEN ? ELSE last_seen_mac END,
        mac_address = CASE WHEN ? IS NOT NULL AND (mac_address IS NULL OR mac_address = '') THEN ? ELSE mac_address END,
        updated_at = datetime('now')
      WHERE subnet_id = ? AND ip_address = ?
    `);

    const scanResults = db.prepare('SELECT ip_address, responded, mac_address FROM scan_results WHERE scan_id = ?').all(scanId);
    for (const sr of scanResults) {
      updateIpOnline.run(
        sr.responded ? 1 : 0,
        sr.responded ? 1 : 0,
        sr.mac_address, sr.mac_address,
        sr.mac_address, sr.mac_address,
        subnetId, sr.ip_address
      );
    }

    // Mark completed
    db.prepare("UPDATE network_scans SET status = 'completed', scanned_ips = ?, conflicts_found = ?, completed_at = datetime('now') WHERE id = ?")
      .run(scannedCount, conflictsFound, scanId);
  } catch (err) {
    db.prepare("UPDATE network_scans SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?")
      .run(err.message, scanId);
  } finally {
    // Clean up the ICMP session
    if (icmpSession) {
      try { icmpSession.close(); } catch { /* ignore */ }
    }
  }
}
