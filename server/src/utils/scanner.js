import { execFile } from 'child_process';
import { parseCidr, longToIp } from './ip.js';
import { parseArpingMac, readArpCache } from './arp-cache.js';
import { localIpv4Set } from './local-addresses.js';
import { ARPING_TIMEOUT_MS, PING_TIMEOUT_MS, SCAN_BATCH_SIZE } from '../config/defaults.js';
import { getSetting } from '../db/init.js';
import * as IpAddress from '../models/ip-address.js';
import * as ScanRun from '../models/scan-run.js';
import * as DnsRecord from '../models/dns-record.js';

/**
 * Run arping on a single IP. It only responds for directly-reachable peers;
 * off-link targets fall through to ICMP.
 * Returns { responded, mac } or { responded: false, mac: null }.
 */
function arpingIp(ip) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/arping', ['-c', '1', '-w', '1', ip], { timeout: ARPING_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve({ responded: false, mac: null });
        return;
      }
      resolve({
        responded: true,
        mac: parseArpingMac(stdout)
      });
    });
  });
}

function pingIp(ip) {
  return new Promise((resolve) => {
    const timeoutSeconds = Math.max(1, Math.ceil(PING_TIMEOUT_MS / 1000));
    execFile('ping', ['-c', '1', '-W', String(timeoutSeconds), ip], { timeout: PING_TIMEOUT_MS + 500 }, (error) => {
      resolve({ responded: !error, mac: null });
    });
  });
}

/**
 * Probe an IP with ARP first, then ICMP if ARP gets no response.
 * This is intentionally a single logical probe for lifecycle purposes:
 * callers insert one scan_results row and emit one "scanned" event per IP.
 * ARP is cheap and captures MAC addresses on directly-connected networks;
 * ICMP is the fallback for hosts that do not answer ARP or are off-link.
 */
async function probeIp(ip) {
  const arp = await arpingIp(ip);
  if (arp.responded) return { ...arp, method: 'arp' };

  const icmp = await pingIp(ip);
  return { ...icmp, method: 'icmp' };
}

/**
 * Resolve whether an IP should be included in a liveness scan.
 * Inheritance: IP override → Subnet override → Folder default → true
 */
function shouldScanIp(ipOverride, subnetDefault) {
  if (ipOverride != null) return !!ipOverride;
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
 * Uses arping first, then system ping ICMP when ARP gets no response.
 * Reads the OS ARP cache to capture MAC addresses learned during probes.
 * Resumes from where it left off if scan_results already exist for some IPs.
 * Updates the database with progress and results as it goes.
 *
 * @param {Object} [options]
 * @param {string[]} [options.targetIps], scan only these IPs (bypasses scan_enabled checks)
 * @param {boolean} [options.updateModel=true], update ip_addresses model after scan
 * @returns {Promise<{ method: 'arp+icmp', results?: Object }>}
 */
export async function startScan(db, scanId, subnetId, options = {}) {
  const { targetIps = null, updateModel = true } = options;
  const isTargeted = Array.isArray(targetIps) && targetIps.length > 0;
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  if (!subnet) {
    ScanRun.markFailed(db, scanId, 'Subnet not found');
    return;
  }

  const probeMethods = new Map();

  console.log(`[scanner] Subnet ${subnet.cidr}: using ARP probes with ICMP fallback`);

  // Resolve subnet-level scan default from inheritance chain (subnet → global setting)
  let subnetDefault = true;
  let overrideMap = new Map();
  if (!isTargeted) {
    if (subnet.scan_enabled !== null && subnet.scan_enabled !== undefined) {
      subnetDefault = !!subnet.scan_enabled;
    } else {
      const val = getSetting('default_scan_enabled');
      subnetDefault = val != null ? (val === '1' || val === 'true') : true;
    }

    // Pre-load per-IP scan_enabled overrides
    const ipOverrides = db.prepare(
      'SELECT ip_address, scan_enabled FROM ip_addresses WHERE subnet_id = ? AND scan_enabled IS NOT NULL'
    ).all(subnetId);
    overrideMap = new Map(ipOverrides.map(r => [r.ip_address, r.scan_enabled]));
  }

  // Build IP list, either from targetIps or from subnet CIDR range
  let ipsToScan;
  let totalIps;
  if (isTargeted) {
    ipsToScan = targetIps;
    totalIps = targetIps.length;
  } else {
    const parsed = parseCidr(subnet.cidr);
    const startIpLong = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
    const endIpLong = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;
    totalIps = endIpLong - startIpLong + 1;
    ipsToScan = [];
    for (let ipLong = startIpLong; ipLong <= endIpLong; ipLong++) {
      ipsToScan.push(longToIp(ipLong));
    }
  }

  // Check for already-scanned IPs (resume support)
  const alreadyScanned = ScanRun.existingResultIps(db, scanId);

  // Load existing counts from partial run
  let scannedCount = alreadyScanned.size;
  let conflictsFound = ScanRun.countConflicts(db, scanId);

  if (alreadyScanned.size > 0) {
    console.log(`[scanner] Resuming scan #${scanId}: ${alreadyScanned.size} IPs already scanned, continuing from where we left off`);
  }

  // Update scan status to running
  ScanRun.markRunning(db, scanId, totalIps);

  // Get existing IP assignments for conflict detection
  const assignments = db.prepare(`
    SELECT ip_address, mac_address, hostname, status FROM ip_addresses
    WHERE subnet_id = ? AND status IN ('assigned', 'locked')
  `).all(subnetId);
  const assignmentMap = new Map(assignments.map(a => [a.ip_address, a]));

  // Active DHCP leases are assigned. Historic ip_addresses rows with
  // status='dhcp' are not enough; restored lease history may have no active
  // lease on this instance.
  const activeLeases = db.prepare(`
    SELECT ip_address, mac_address, hostname FROM dhcp_leases
    WHERE subnet_id = ?
      AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
  `).all(subnetId);
  for (const l of activeLeases) {
    if (!assignmentMap.has(l.ip_address)) {
      assignmentMap.set(l.ip_address, { ip_address: l.ip_address, mac_address: l.mac_address, hostname: l.hostname, status: 'dhcp' });
    }
  }

  // Also include DHCP reservations, an IP with a reservation is not rogue
  // (covers cases where ip_addresses wasn't synced yet)
  const reservations = db.prepare(`
    SELECT ip_address, mac_address, hostname FROM dhcp_reservations
    WHERE subnet_id = ?
  `).all(subnetId);
  for (const r of reservations) {
    if (!assignmentMap.has(r.ip_address)) {
      assignmentMap.set(r.ip_address, { ip_address: r.ip_address, mac_address: r.mac_address, hostname: r.hostname, status: 'dhcp' });
    }
  }

  // Also include DNS-owned A records, not rogue. Do not trust stale
  // ip_addresses.hostname alone; restored DHCP lease history can retain a
  // hostname after the active lease is gone. Predicate lives in dns-record.js
  // so the scanner, the IP view, and the passive path all agree on it.
  const ipsToScanSet = new Set(ipsToScan);

  // Our own interface addresses always answer a probe. Without this they look
  // like an unknown host on an unassigned address and get flagged rogue.
  for (const localIp of localIpv4Set()) {
    if (ipsToScanSet.has(localIp) && !assignmentMap.has(localIp)) {
      assignmentMap.set(localIp, {
        ip_address: localIp,
        mac_address: null,
        hostname: null,
        status: 'assigned'
      });
    }
  }

  const dnsAssigned = DnsRecord.listDnsAssignedIps(db).filter(r => ipsToScanSet.has(r.ip_address));
  for (const d of dnsAssigned) {
    if (!assignmentMap.has(d.ip_address)) {
      assignmentMap.set(d.ip_address, {
        ip_address: d.ip_address,
        mac_address: null,
        hostname: d.hostname,
        status: 'assigned'
      });
    }
  }

  try {
    // Scan in batches for reasonable speed
    for (let i = 0; i < ipsToScan.length; i += SCAN_BATCH_SIZE) {
      const batch = ipsToScan.slice(i, i + SCAN_BATCH_SIZE);
      const promises = [];

      for (const ip of batch) {
        // Skip IPs already scanned in a previous partial run
        if (alreadyScanned.has(ip)) continue;

        // Check scan_enabled for this IP (skip for targeted probes)
        if (!isTargeted) {
          const override = overrideMap.get(ip);
          if (!shouldScanIp(override !== undefined ? override : null, subnetDefault)) {
            continue; // skip, scanning disabled for this IP
          }
        }

        promises.push(probeIp(ip).then(result => ({ ip, ...result })));
      }

      if (promises.length === 0) continue;

      const results = await Promise.all(promises);

      // Read the ARP cache to capture MACs the kernel learned from ping responses.
      // Forced, because the point is to see entries these probes just created.
      let arpCache = null;
      if (results.some(r => r.responded && !r.mac)) {
        arpCache = readArpCache({ force: true });
      }

      for (const result of results) {
        // Enrich results with ARP cache MAC when probe didn't return one
        if (result.responded && !result.mac && arpCache) {
          result.mac = arpCache.get(result.ip) || null;
        }

        let isConflict = 0;
        let conflictReason = null;
        const assignment = assignmentMap.get(result.ip);

        if (result.responded) {
          if (!assignment) {
            // IP responded but not assigned, rogue device
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

        probeMethods.set(result.ip, result.method);

        ScanRun.insertResult(db, scanId, {
          ip: result.ip,
          mac: result.mac,
          responded: result.responded,
          isConflict,
          conflictReason
        });
      }

      scannedCount += results.length;

      // Update progress
      ScanRun.updateProgress(db, scanId, { scannedIps: scannedCount, conflictsFound });
    }

    // Update ip_addresses via model, liveness, MAC, rogue state, lifecycle fields
    if (updateModel) {
      const scanResults = ScanRun.getMaterializedResults(db, scanId);

      const conflictIps = new Set();
      for (const sr of scanResults) {
        IpAddress.updateFromScan(db, subnetId, sr.ip_address, {
          responded: sr.responded,
          mac: sr.mac_address,
          isConflict: sr.is_conflict,
          conflictReason: sr.conflict_reason
        });
        if (sr.is_conflict) conflictIps.add(sr.ip_address);
      }

      // Clear rogue on IPs in this subnet that weren't flagged in this scan
      // (only for full subnet scans, targeted probes shouldn't clear other IPs)
      if (!isTargeted) {
        IpAddress.clearRogueForSubnet(db, subnetId, conflictIps);
      }
    }

    // Mark completed
    ScanRun.markCompleted(db, scanId, { scannedIps: scannedCount, conflictsFound });

    // Prune old scan_results, keep only this scan (skip for targeted probes)
    if (!isTargeted) {
      ScanRun.pruneOldResults(db, subnetId, scanId);
    }
  } catch (err) {
    ScanRun.markFailed(db, scanId, err.message);
  }

  return { method: 'arp+icmp', results: Object.fromEntries(probeMethods) };
}
