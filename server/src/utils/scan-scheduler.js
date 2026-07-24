import { getDb } from '../db/init.js';
import { startScan } from './scanner.js';
import { MAX_SCAN_SIZE } from '../config/defaults.js';
import * as ScanRun from '../models/scan-run.js';

const INTERVAL_MS = {
  '': null,
  'off': null,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

let timer = null;
const SCHEDULER_TICK_MS = 60 * 1000;

function intervalToMs(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (Object.hasOwn(INTERVAL_MS, raw)) return INTERVAL_MS[raw];

  // Backward compatibility for any installs that persisted the old
  // integer-minutes shape before the UI/API contract was aligned.
  if (/^\d+$/.test(raw)) {
    const minutes = parseInt(raw, 10);
    return minutes > 0 ? minutes * 60 * 1000 : null;
  }

  return null;
}

function scanEnabledSql() {
  return `
    COALESCE(
      s.scan_enabled,
      CASE
        WHEN (SELECT value FROM settings WHERE key = 'default_scan_enabled') IN ('1', 'true') THEN 1
        WHEN (SELECT value FROM settings WHERE key = 'default_scan_enabled') IN ('0', 'false') THEN 0
        ELSE 1
      END
    ) = 1
  `;
}

function checkScheduledScans() {
  const db = getDb();
  if (!db) return;

  const subnets = db.prepare(`
    SELECT s.*,
      COALESCE(s.scan_interval, (SELECT value FROM settings WHERE key = 'default_scan_interval')) AS effective_scan_interval
    FROM subnets s
    WHERE s.status = 'allocated' AND s.total_addresses <= ${MAX_SCAN_SIZE}
      AND ${scanEnabledSql()}
  `).all();

  for (const subnet of subnets) {
    const intervalMs = intervalToMs(subnet.effective_scan_interval);
    if (!intervalMs) continue;

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
      const pending = ScanRun.createPendingIfIdle(db, subnet.id);
      if (!pending.created) continue;

      console.log(`[scan-scheduler] Starting scheduled scan for ${subnet.cidr} (interval: ${subnet.effective_scan_interval})`);
      startScan(db, pending.scanId, subnet.id);
    } catch (err) {
      console.error(`[scan-scheduler] Failed to start scan for ${subnet.cidr}:`, err.message);
    }
  }
}

export function startScanScheduler() {
  if (timer) return;
  // Check every 60 seconds
  timer = setInterval(checkScheduledScans, SCHEDULER_TICK_MS);
  checkScheduledScans();
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
    WHERE s.status = 'allocated' AND s.total_addresses <= ${MAX_SCAN_SIZE}
      AND ${scanEnabledSql()}
  `).all();

  let earliest = null;

  for (const subnet of subnets) {
    const intervalMs = intervalToMs(subnet.effective_scan_interval);
    if (!intervalMs) continue;
    let nextTime;

    const activeScan = db.prepare(`
      SELECT created_at, started_at FROM network_scans
      WHERE subnet_id = ? AND status IN ('pending', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(subnet.id);

    if (activeScan) {
      const base = activeScan.started_at || activeScan.created_at;
      if (base) {
        nextTime = new Date(base + 'Z').getTime() + intervalMs;
      } else {
        nextTime = Date.now() + intervalMs;
      }
      if (nextTime <= Date.now()) nextTime = Date.now() + SCHEDULER_TICK_MS;
      if (earliest === null || nextTime < earliest) earliest = nextTime;
      continue;
    }

    const lastScan = db.prepare(`
      SELECT completed_at FROM network_scans WHERE subnet_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(subnet.id);

    if (lastScan) {
      nextTime = new Date(lastScan.completed_at + 'Z').getTime() + intervalMs;
    } else {
      // No completed scan yet, next scheduler check can trigger it.
      nextTime = Date.now() + SCHEDULER_TICK_MS;
    }
    if (nextTime <= Date.now()) nextTime = Date.now() + SCHEDULER_TICK_MS;

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
