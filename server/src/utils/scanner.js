import { execFile } from 'child_process';
import os from 'os';
import { parseCidr, longToIp, isIpInSubnet } from './ip.js';

/**
 * Run arping on a single IP (Layer 2 — local subnets only).
 * Returns { responded, mac } or { responded: false, mac: null }.
 */
function arpingIp(ip) {
  return new Promise((resolve) => {
    execFile('sudo', ['arping', '-c', '1', '-w', '1', ip], { timeout: 5000 }, (error, stdout) => {
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
 * Run ICMP ping on a single IP (Layer 3 — works across routers).
 * Cannot detect MAC addresses.
 */
function pingIp(ip) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '1', ip], { timeout: 5000 }, (error) => {
      resolve({ responded: !error, mac: null });
    });
  });
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
 * Inheritance: IP override → Subnet override → Org default → true
 */
function shouldScanIp(ipOverride, subnetDefault) {
  if (ipOverride !== null && ipOverride !== undefined) return !!ipOverride;
  return subnetDefault;
}

/**
 * Start an async network scan for a subnet.
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
  const probeIp = local ? arpingIp : pingIp;
  console.log(`[scanner] Subnet ${subnet.cidr} — using ${local ? 'ARP' : 'ICMP'} probes`);

  // Resolve subnet-level scan default from inheritance chain
  let subnetDefault = true;
  if (subnet.scan_enabled !== null && subnet.scan_enabled !== undefined) {
    subnetDefault = !!subnet.scan_enabled;
  } else if (subnet.folder_id) {
    const folder = db.prepare('SELECT scan_enabled FROM folders WHERE id = ?').get(subnet.folder_id);
    if (folder) subnetDefault = !!folder.scan_enabled;
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

  // Update scan status to running
  db.prepare("UPDATE network_scans SET status = 'running', total_ips = ?, started_at = datetime('now') WHERE id = ?").run(totalIps, scanId);

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

  let scannedCount = 0;
  let conflictsFound = 0;

  try {
    // Scan in batches of 10 for reasonable speed
    const BATCH_SIZE = 10;
    for (let batchStart = startIp; batchStart <= endIp; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endIp);
      const promises = [];

      for (let ipLong = batchStart; ipLong <= batchEnd; ipLong++) {
        const ip = longToIp(ipLong);

        // Check scan_enabled for this IP
        const override = overrideMap.get(ip);
        if (!shouldScanIp(override !== undefined ? override : null, subnetDefault)) {
          continue; // skip — scanning disabled for this IP
        }

        promises.push(probeIp(ip).then(result => ({ ip, ...result })));
      }

      const results = await Promise.all(promises);

      for (const result of results) {
        let isConflict = 0;
        let conflictReason = null;
        const assignment = assignmentMap.get(result.ip);

        if (result.responded) {
          if (!assignment) {
            // IP responded but not assigned — rogue device
            isConflict = 1;
            conflictReason = 'Rogue device (IP not assigned)';
          } else if (local && assignment.mac_address && result.mac &&
                     assignment.mac_address.toLowerCase() !== result.mac) {
            // MAC mismatch — only detectable on local (ARP) subnets
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
        updated_at = datetime('now')
      WHERE subnet_id = ? AND ip_address = ?
    `);

    const scanResults = db.prepare('SELECT ip_address, responded, mac_address FROM scan_results WHERE scan_id = ?').all(scanId);
    for (const sr of scanResults) {
      updateIpOnline.run(
        sr.responded ? 1 : 0,
        sr.responded ? 1 : 0,
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
  }
}
