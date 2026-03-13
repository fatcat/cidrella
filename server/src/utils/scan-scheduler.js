import { getDb } from '../db/init.js';
import { startScan } from './scanner.js';

const INTERVAL_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

let timer = null;

function checkScheduledScans() {
  const db = getDb();
  if (!db) return;

  const subnets = db.prepare(`
    SELECT s.*,
      COALESCE(s.scan_interval, (SELECT value FROM settings WHERE key = 'default_scan_interval')) AS effective_scan_interval
    FROM subnets s
    WHERE s.status = 'allocated' AND s.prefix_length > 20
      AND COALESCE(s.scan_enabled, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_scan_enabled'), 1) = 1
  `).all();

  for (const subnet of subnets) {
    const intervalMs = INTERVAL_MS[subnet.effective_scan_interval];
    if (!intervalMs) continue;

    // Check if a scan is already running for this subnet
    const running = db.prepare(`
      SELECT id FROM network_scans WHERE subnet_id = ? AND status IN ('pending', 'running')
    `).get(subnet.id);
    if (running) continue;

    // Check if last completed scan is old enough
    const lastScan = db.prepare(`
      SELECT completed_at FROM network_scans WHERE subnet_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(subnet.id);

    if (lastScan) {
      const lastTime = new Date(lastScan.completed_at + 'Z').getTime();
      if (Date.now() - lastTime < intervalMs) continue;
    }

    // Create and start a new scan
    try {
      const result = db.prepare(`
        INSERT INTO network_scans (subnet_id, status) VALUES (?, 'pending')
      `).run(subnet.id);

      console.log(`[scan-scheduler] Starting scheduled scan for ${subnet.cidr} (interval: ${subnet.effective_scan_interval})`);
      startScan(db, result.lastInsertRowid, subnet.id);
    } catch (err) {
      console.error(`[scan-scheduler] Failed to start scan for ${subnet.cidr}:`, err.message);
    }
  }
}

export function startScanScheduler() {
  if (timer) return;
  // Check every 60 seconds
  timer = setInterval(checkScheduledScans, 60 * 1000);
  console.log('Scan scheduler started');
}

/**
 * Calculate when the next scheduled scan will run.
 * Returns ISO string or null if no scans are scheduled.
 */
export function getNextScanTime() {
  const db = getDb();
  if (!db) return null;

  const subnets = db.prepare(`
    SELECT s.id,
      COALESCE(s.scan_interval, (SELECT value FROM settings WHERE key = 'default_scan_interval')) AS effective_scan_interval
    FROM subnets s
    WHERE s.status = 'allocated' AND s.prefix_length > 20
      AND COALESCE(s.scan_enabled, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_scan_enabled'), 1) = 1
  `).all();

  let earliest = null;

  for (const subnet of subnets) {
    const intervalMs = INTERVAL_MS[subnet.effective_scan_interval];
    if (!intervalMs) continue;

    const lastScan = db.prepare(`
      SELECT completed_at FROM network_scans WHERE subnet_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(subnet.id);

    let nextTime;
    if (lastScan) {
      nextTime = new Date(lastScan.completed_at + 'Z').getTime() + intervalMs;
    } else {
      // No completed scan yet — next check cycle will trigger it
      nextTime = Date.now();
    }

    if (earliest === null || nextTime < earliest) {
      earliest = nextTime;
    }
  }

  return earliest !== null ? new Date(earliest).toISOString() : null;
}

export function stopScanScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
