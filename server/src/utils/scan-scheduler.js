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
    SELECT s.* FROM subnets s
    WHERE s.scan_interval IS NOT NULL AND s.status = 'allocated' AND s.prefix_length > 20
  `).all();

  for (const subnet of subnets) {
    const intervalMs = INTERVAL_MS[subnet.scan_interval];
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
    const result = db.prepare(`
      INSERT INTO network_scans (subnet_id, status, initiated_by) VALUES (?, 'pending', 'scheduler')
    `).run(subnet.id);

    console.log(`[scan-scheduler] Starting scheduled scan for ${subnet.cidr} (interval: ${subnet.scan_interval})`);
    startScan(db, result.lastInsertRowid, subnet.id);
  }
}

export function startScanScheduler() {
  if (timer) return;
  // Check every 60 seconds
  timer = setInterval(checkScheduledScans, 60 * 1000);
  console.log('Scan scheduler started');
}

export function stopScanScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
