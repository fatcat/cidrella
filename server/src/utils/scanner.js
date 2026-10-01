import os from 'os';
import { execFile } from 'child_process';
import { parseNetwork, longToIp, parsedNetworkContains } from './ip.js';
import { addressFamily, canonicalizeIp } from './address.js';
import { parseArpingMac, readArpCache } from './arp-cache.js';
import { findNeighbor, readNdCache } from './nd-cache.js';
import { observeIpv6Presence } from '../services/ip-lifecycle-service.js';
import { ipv6DiscoveryPolicy } from '../models/dhcp-scope.js';
import { ARPING_TIMEOUT_MS, PING_TIMEOUT_MS, SCAN_BATCH_SIZE } from '../config/defaults.js';
import { getSetting } from '../db/init.js';
import { ipv6Enabled, IPV6_DISABLED_ERROR } from './ipv6-support.js';
import { observeScanResult, reconcileScanRogues } from '../services/ip-lifecycle-service.js';
import * as ScanRun from '../models/scan-run.js';

/**
 * Run arping on a single IP. It only responds for directly-reachable peers;
 * off-link targets fall through to ICMP.
 * Returns { responded, mac } or { responded: false, mac: null }.
 */
function arpingIp(ip) {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/arping',
      ['-c', '1', '-w', '1', ip],
      { timeout: ARPING_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve({ responded: false, mac: null });
          return;
        }
        resolve({
          responded: true,
          mac: parseArpingMac(stdout),
        });
      },
    );
  });
}

function pingIp(ip, { count = 1 } = {}) {
  return new Promise((resolve) => {
    const timeoutSeconds = Math.max(1, Math.ceil(PING_TIMEOUT_MS / 1000));
    const family = addressFamily(ip) === 6 ? ['-6'] : [];
    execFile(
      'ping',
      [...family, '-c', String(count), '-W', String(timeoutSeconds), ip],
      { timeout: PING_TIMEOUT_MS * count + 500 },
      (error) => {
        resolve({ responded: !error, mac: null });
      },
    );
  });
}

/**
 * Probe an IP with ARP first, then ICMP if ARP gets no response.
 * This is intentionally a single logical probe for lifecycle purposes:
 * callers insert one scan_results row and emit one "scanned" event per IP.
 * ARP is cheap and captures MAC addresses on directly-connected networks;
 * ICMP is the fallback for hosts that do not answer ARP or are off-link.
 * IPv6 has no ARP (it is IPv4-only): an ICMPv6 echo makes the kernel resolve
 * the neighbor, and confirmByNeighborDiscovery reads that back. A link-local
 * address is only reachable through its interface, so it is pinged zoned.
 */
async function probeIp(ip, iface = null) {
  if (addressFamily(ip) === 6) {
    const icmp = await pingIp(iface ? `${ip}%${iface}` : ip);
    return { ...icmp, method: 'icmpv6' };
  }
  const arp = await arpingIp(ip);
  if (arp.responded) return { ...arp, method: 'arp' };

  const icmp = await pingIp(ip);
  return { ...icmp, method: 'icmp' };
}

// Neighbor Discovery is the IPv6 counterpart of arping here. The echo makes
// the kernel solicit the neighbor, and a Neighbor Advertisement is answered
// by hosts whose firewall drops echo (Windows does by default). REACHABLE is
// a confirmation the kernel got within the last reachable time. DELAY and
// PROBE mean it is still confirming a STALE entry, so those are re-read until
// they settle; a plain STALE entry is old news and proves nothing.
const ND_CONFIRMED = 'REACHABLE';
const ND_SETTLING = new Set(['DELAY', 'PROBE']);
export const ND_SETTLE_POLL_MS = 1000;
const ND_SETTLE_POLLS = 8; // DELAY_FIRST_PROBE_TIME 5s plus three 1s probes

/**
 * Mark an IPv6 echo non-responder as responded (method 'ndp') when the
 * neighbor table confirms it. `results` are { ip, iface, responded, mac }.
 */
export async function confirmByNeighborDiscovery(
  results,
  { read = readNdCache, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  let pending = results.filter((r) => !r.responded);
  for (let poll = 0; pending.length > 0; poll++) {
    const table = read({ force: true });
    const settling = [];
    for (const result of pending) {
      const entry = findNeighbor(table, result.ip, result.iface);
      if (entry?.state === ND_CONFIRMED) {
        result.responded = true;
        result.mac = result.mac || entry.mac || null;
        result.method = 'ndp';
      } else if (entry && ND_SETTLING.has(entry.state)) {
        settling.push(result);
      }
    }
    pending = settling;
    if (pending.length === 0 || poll >= ND_SETTLE_POLLS) break;
    await wait(ND_SETTLE_POLL_MS);
  }
  return results;
}

/**
 * The interfaces that hold an address inside `parsed`, for the all-nodes
 * multicast probe. An IPv6 network CIDRella is not attached to cannot be
 * discovered this way; its addresses still arrive through leases and DNS.
 */
function interfacesOnNetwork(parsed) {
  const names = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (
      (addrs || []).some((a) => a.family === 'IPv6' && parsedNetworkContains(parsed, a.address))
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Discover the hosts of an IPv6 network without walking it: ping the
 * all-nodes multicast group on each attached interface, then read the
 * kernel's neighbor table for entries inside the prefix, plus link-local
 * entries on those same interfaces (a link-local address belongs to no
 * prefix, so the interface is what ties it to the network). Returns the
 * discovered addresses with their MACs.
 */
export async function discoverIpv6Hosts(parsed, { neighbors = readNdCache } = {}) {
  const interfaces = interfacesOnNetwork(parsed);
  for (const name of interfaces) {
    await pingIp(`ff02::1%${name}`, { count: 2 });
  }
  const found = [];
  for (const [key, entry] of neighbors({ force: true })) {
    const ip = entry.ip ?? key;
    const onLink = /^fe[89ab]/i.test(ip) && interfaces.includes(entry.interface);
    if (!onLink && !parsedNetworkContains(parsed, ip)) continue;
    found.push({ ip, mac: entry.mac, interface: entry.interface, state: entry.state });
  }
  return { interfaces, hosts: found };
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
  const interrupted = db
    .prepare("SELECT * FROM network_scans WHERE status IN ('running', 'pending')")
    .all();

  for (const scan of interrupted) {
    console.log(
      `[scanner] Resuming interrupted scan #${scan.id} for subnet ${scan.subnet_id} (${scan.scanned_ips}/${scan.total_ips} done)`,
    );
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
  const parsed = parseNetwork(subnet.cidr);
  if (parsed.family === 6 && !ipv6Enabled()) {
    ScanRun.markFailed(db, scanId, IPV6_DISABLED_ERROR);
    throw new Error(IPV6_DISABLED_ERROR);
  }

  console.log(
    parsed.family === 6
      ? `[scanner] Subnet ${subnet.cidr}: all-nodes multicast then the neighbor table`
      : `[scanner] Subnet ${subnet.cidr}: using ARP probes with ICMP fallback`,
  );

  // Resolve subnet-level scan default from inheritance chain (subnet → global setting)
  let subnetDefault = true;
  let overrideMap = new Map();
  if (!isTargeted) {
    if (subnet.scan_enabled !== null && subnet.scan_enabled !== undefined) {
      subnetDefault = !!subnet.scan_enabled;
    } else {
      const val = getSetting('default_scan_enabled');
      subnetDefault = val != null ? val === '1' || val === 'true' : true;
    }

    // Pre-load per-IP scan_enabled overrides
    const ipOverrides = db
      .prepare(
        'SELECT ip_address, scan_enabled FROM ip_addresses WHERE subnet_id = ? AND scan_enabled IS NOT NULL',
      )
      .all(subnetId);
    overrideMap = new Map(ipOverrides.map((r) => [r.ip_address, r.scan_enabled]));
  }

  // Build IP list, either from targetIps or from subnet CIDR range. An IPv6
  // prefix is never enumerated: its list is whatever the link answered plus
  // every address CIDRella already holds an allocation for, so a quiet static
  // host still gets an echo and can go offline.
  let ipsToScan;
  let totalIps;
  // The interface a link-local address is probed on.
  const probeInterfaces = new Map();
  const policy = parsed.family === 6 ? ipv6DiscoveryPolicy(db, subnetId) : null;
  if (isTargeted) {
    // Every lookup below is by the stored (canonical) spelling.
    ipsToScan = [...new Set(targetIps.map((ip) => canonicalizeIp(ip) ?? ip))];
    totalIps = ipsToScan.length;
  } else if (parsed.family === 6) {
    const discovered = await discoverIpv6Hosts(parsed);
    // Neighbor Discovery is liveness evidence in its own right and, on a
    // SLAAC network, the allocation claim itself. Record it before the
    // assignment snapshot below so a self-assigned address counts as
    // assigned and is not mistaken for a rogue.
    // A STALE (or older) entry is only what the kernel remembers, so it does
    // not bring an offline row back online: a host that left would flip
    // online here and offline at its echo on every scan. Such a host is
    // echoed instead, and comes back online if it answers.
    const recheck = [];
    if (updateModel) {
      const offline = db.prepare(
        'SELECT 1 FROM ip_addresses WHERE subnet_id = ? AND ip_address = ? AND is_online = 0',
      );
      for (const host of discovered.hosts) {
        const linkLocal = /^fe[89ab]/i.test(host.ip);
        if (host.state !== 'REACHABLE' && offline.get(subnetId, host.ip)) {
          recheck.push(host);
          if (linkLocal && host.interface) probeInterfaces.set(host.ip, host.interface);
          continue;
        }
        observeIpv6Presence(db, subnetId, host.ip, {
          interfaceId: linkLocal ? host.interface : null,
          mac: host.mac,
          policy,
        });
      }
    }
    // Echo what the link answered, every allocated address, and every row
    // that is online now, unassigned and link-local ones included: anything
    // the scan reports online it must also be able to report gone, or the
    // stale sweep (which leaves scanned networks to the scanner) never will.
    // A link-local row is pinged on its interface.
    const persisted = db
      .prepare(
        `SELECT ip_address, interface_id FROM ip_addresses
         WHERE subnet_id = ? AND allocation_state != 'system'
           AND ((allocation_state != 'unassigned' AND interface_id IS NULL) OR is_online = 1)`,
      )
      .all(subnetId);
    for (const row of persisted) {
      if (/^fe[89ab]/i.test(row.ip_address)) {
        if (row.interface_id) probeInterfaces.set(row.ip_address, row.interface_id);
      }
    }
    const globals = discovered.hosts.map((host) => host.ip).filter((ip) => !/^fe[89ab]/i.test(ip));
    ipsToScan = [
      ...new Set([
        ...globals,
        ...recheck
          .map((host) => host.ip)
          .filter((ip) => probeInterfaces.has(ip) || !/^fe[89ab]/i.test(ip)),
        ...persisted
          .map((row) => row.ip_address)
          .filter((ip) => !/^fe[89ab]/i.test(ip) || probeInterfaces.has(ip)),
      ]),
    ];
    totalIps = ipsToScan.length;
  } else {
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
    console.log(
      `[scanner] Resuming scan #${scanId}: ${alreadyScanned.size} IPs already scanned, continuing from where we left off`,
    );
  }

  // Update scan status to running
  ScanRun.markRunning(db, scanId, totalIps);

  // Canonical allocation is the only assignment authority used by scans.
  const assignments = db
    .prepare(
      `
    SELECT ip_address, mac_address, hostname, allocation_state
    FROM ip_addresses
    WHERE subnet_id = ? AND allocation_state != 'unassigned'
  `,
    )
    .all(subnetId);
  const assignmentMap = new Map(assignments.map((a) => [a.ip_address, a]));

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

        const iface = probeInterfaces.get(ip) || null;
        promises.push(probeIp(ip, iface).then((result) => ({ ip, iface, ...result })));
      }

      if (promises.length === 0) continue;

      const results = await Promise.all(promises);
      if (parsed.family === 6) await confirmByNeighborDiscovery(results);

      // Read the neighbor tables to capture MACs the kernel learned from ping
      // responses. Forced, because the point is to see entries these probes
      // just created. IPv6 answers come from the ND table, IPv4 from ARP.
      let arpCache = null;
      let ndCache = null;
      if (results.some((r) => r.responded && !r.mac)) {
        if (parsed.family === 6) ndCache = readNdCache({ force: true });
        else arpCache = readArpCache({ force: true });
      }

      for (const result of results) {
        // Enrich results with the neighbor-table MAC when the probe didn't return one
        if (result.responded && !result.mac && arpCache) {
          result.mac = arpCache.get(result.ip) || null;
        }
        if (result.responded && !result.mac && ndCache) {
          result.mac = findNeighbor(ndCache, result.ip, result.iface)?.mac || null;
        }

        let isConflict = 0;
        let conflictReason = null;
        const assignment = assignmentMap.get(result.ip);

        if (result.responded) {
          // An unassigned address answering is a rogue on IPv4 and on a
          // stateful DHCPv6 network. Where hosts assign themselves (SLAAC
          // modes) or nothing hands out addresses, it is simply a host.
          // A link-local address is never handed out, so it is never a rogue.
          const rogueMeaningful =
            parsed.family === 4 || (policy?.mode === 'stateful' && !/^fe[89ab]/i.test(result.ip));
          if (!assignment && rogueMeaningful) {
            isConflict = 1;
            conflictReason = 'Rogue device (IP not assigned)';
          } else if (
            assignment?.mac_address &&
            result.mac &&
            assignment.mac_address.toLowerCase() !== result.mac
          ) {
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
          conflictReason,
        });
      }

      scannedCount += results.length;

      // Update progress
      ScanRun.updateProgress(db, scanId, { scannedIps: scannedCount, conflictsFound });
    }

    // Update ip_addresses via model, liveness, MAC, rogue state, lifecycle fields
    if (updateModel) {
      if (!ScanRun.targetIsCurrent(db, scanId)) {
        throw new Error('Network topology changed during scan; results discarded');
      }
      const scanResults = ScanRun.getMaterializedResults(db, scanId);

      const conflictIps = new Set();
      for (const sr of scanResults) {
        observeScanResult(db, subnetId, sr.ip_address, {
          responded: sr.responded,
          mac: sr.mac_address,
          isConflict: sr.is_conflict,
          conflictReason: sr.conflict_reason,
        });
        if (sr.is_conflict) conflictIps.add(sr.ip_address);
      }

      // Clear rogue on the addresses this scan re-checked and did not flag
      // (only for full subnet scans, targeted probes shouldn't clear other
      // IPs). Only those: an IPv6 scan probes a sparse set, and a rogue it
      // never looked at is still a rogue.
      if (!isTargeted) {
        const probed = new Set(scanResults.map((sr) => sr.ip_address));
        reconcileScanRogues(db, subnetId, conflictIps, probed);
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
