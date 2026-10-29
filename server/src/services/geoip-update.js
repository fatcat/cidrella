/**
 * Keeping the GeoIP database current: the download from DB-IP (manual or on
 * the schedule) and the reload in the DNS proxy that follows. The proxy only
 * reads the file; fetching it and recording when is the web app's.
 */
import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getSetting, setSetting } from '../db/init.js';
import { recordAudit } from './audit.js';
import { geoipDbPath, loadMmdb } from '../utils/dns-proxy.js';
import { proxyLog } from '../dns-proxy/log.js';
import {
  GEOIP_DOWNLOAD_TIMEOUT_MS,
  GEOIP_CHECK_INTERVAL_MS,
  GEOIP_STARTUP_DELAY_MS,
} from '../config/defaults.js';

// Download DB-IP Lite MMDB
export async function downloadMmdb() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const url = `https://download.db-ip.com/free/dbip-country-lite-${year}-${month}.mmdb.gz`;

  const dbPath = geoipDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmpPath = dbPath + '.tmp.' + process.pid;

  proxyLog('info', 'Downloading GeoIP database', { url });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOIP_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CIDRella-GeoIP/1.0' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Pipe gzipped response through gunzip to file
    const gunzip = createGunzip();
    const fileStream = fs.createWriteStream(tmpPath);
    const body = Readable.fromWeb(response.body);

    await pipeline(body, gunzip, fileStream);

    // Atomic rename
    fs.renameSync(tmpPath, dbPath);

    setSetting('geoip_last_updated', new Date().toISOString());
    proxyLog('info', 'GeoIP database downloaded successfully');

    // Load the fresh file only while GeoIP is on: a reader is what blocks.
    if (getSetting('geoip_enabled') === 'true') await loadMmdb();

    return true;
  } catch (err) {
    clearTimeout(timeout);
    // Clean up temp file
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to download GeoIP database: ${err.message}`);
  }
}

// Map schedule setting to interval in days
function scheduleToDays(schedule) {
  switch (schedule) {
    case 'weekly':
      return 7;
    case 'biweekly':
      return 14;
    case 'monthly':
      return 30;
    default:
      return 0; // 'off'
  }
}

// Auto-update scheduler
export function startGeoipScheduler() {
  // Check every 6 hours if MMDB needs updating
  setInterval(async () => {
    try {
      const enabled = getSetting('geoip_enabled');
      if (enabled !== 'true') return;

      const schedule = getSetting('geoip_update_schedule') || 'monthly';
      if (schedule === 'off') return;

      const intervalDays = scheduleToDays(schedule);
      if (intervalDays === 0) return;

      const lastUpdated = getSetting('geoip_last_updated');
      if (!lastUpdated) return;

      const lastDate = new Date(lastUpdated);
      const daysSinceUpdate = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate >= intervalDays) {
        proxyLog('info', `GeoIP database is older than ${intervalDays} days, downloading update`);
        try {
          await downloadMmdb();
          recordAudit({
            action: 'geoip_db_refreshed',
            entityType: 'geoip_db',
            source: 'scheduler',
            details: { previous: lastUpdated, schedule },
          });
        } catch (err) {
          proxyLog('error', 'GeoIP auto-update failed', { error: err.message });
        }
      }
    } catch (err) {
      proxyLog('error', 'GeoIP scheduler error', { error: err.message });
    }
  }, GEOIP_CHECK_INTERVAL_MS);

  // Initial check after startup
  setTimeout(async () => {
    const enabled = getSetting('geoip_enabled');
    if (enabled !== 'true') return;

    if (!fs.existsSync(geoipDbPath())) {
      proxyLog('info', 'GeoIP enabled but no MMDB found, downloading');
      try {
        await downloadMmdb();
      } catch (err) {
        proxyLog('error', 'GeoIP initial download failed', { error: err.message });
      }
    }
  }, GEOIP_STARTUP_DELAY_MS);
}
