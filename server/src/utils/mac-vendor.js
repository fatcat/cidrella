/**
 * MAC address vendor lookup using the Wireshark manuf database.
 * Downloads and refreshes the OUI database every 24 hours.
 */

import { getDb } from '../db/init.js';

const MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

let refreshTimer = null;

/**
 * Parse the Wireshark manuf file into an array of vendor entries.
 */
function parseManuf(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;

    // Format: PREFIX<tab>SHORT_NAME<tab>FULL_NAME
    // PREFIX can be: AA:BB:CC (24-bit), AA:BB:CC:DD:D0/28 (28-bit), AA:BB:CC:DD:EE/36 (36-bit)
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const rawPrefix = parts[0].trim();
    const shortName = parts[1]?.trim() || null;
    const vendorName = parts[2]?.trim() || shortName;
    if (!rawPrefix || !vendorName) continue;

    let prefix;
    let prefixLength = 24;

    const slashIdx = rawPrefix.indexOf('/');
    if (slashIdx !== -1) {
      prefix = rawPrefix.slice(0, slashIdx).toUpperCase();
      prefixLength = parseInt(rawPrefix.slice(slashIdx + 1), 10);
    } else {
      prefix = rawPrefix.toUpperCase();
    }

    // Normalize: ensure consistent colon-separated uppercase hex
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){2,}$/.test(prefix)) continue;

    entries.push({ prefix, prefixLength, shortName, vendorName });
  }
  return entries;
}

/**
 * Download the Wireshark manuf file and populate the mac_vendors table.
 */
async function refreshVendorDb() {
  const db = getDb();

  try {
    console.log('MAC vendor DB: downloading Wireshark manuf file...');
    const response = await fetch(MANUF_URL);
    if (!response.ok) {
      console.error(`MAC vendor DB: download failed (HTTP ${response.status})`);
      return;
    }

    const text = await response.text();
    const entries = parseManuf(text);
    if (entries.length < 1000) {
      console.error(`MAC vendor DB: parsed only ${entries.length} entries, skipping (possible bad download)`);
      return;
    }

    const insertVendor = db.prepare(
      'INSERT OR REPLACE INTO mac_vendors (prefix, prefix_length, short_name, vendor_name) VALUES (?, ?, ?, ?)'
    );

    const populate = db.transaction(() => {
      db.prepare('DELETE FROM mac_vendors').run();
      for (const e of entries) {
        insertVendor.run(e.prefix, e.prefixLength, e.shortName, e.vendorName);
      }
    });

    populate();
    console.log(`MAC vendor DB: loaded ${entries.length} entries`);
  } catch (err) {
    console.error('MAC vendor DB: refresh error:', err.message);
  }
}

/**
 * Look up the vendor name for a MAC address.
 * Checks 36-bit, 28-bit, then 24-bit prefixes (longest match first).
 * @param {string} mac - MAC address in XX:XX:XX:XX:XX:XX format
 * @returns {string|null} Vendor name or null
 */
export function lookupVendor(mac) {
  if (!mac) return null;

  const db = getDb();
  const upper = mac.toUpperCase();
  const octets = upper.split(':');
  if (octets.length !== 6) return null;

  // Try 36-bit (first 5 octets, last nibble zeroed): AA:BB:CC:DD:E0
  const nibble36 = octets[4].charAt(0) + '0';
  const prefix36 = `${octets[0]}:${octets[1]}:${octets[2]}:${octets[3]}:${nibble36}`;
  const match36 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 36').get(prefix36);
  if (match36) return match36.vendor_name;

  // Try 28-bit (first 4 octets, last nibble zeroed): AA:BB:CC:D0
  const nibble28 = octets[3].charAt(0) + '0';
  const prefix28 = `${octets[0]}:${octets[1]}:${octets[2]}:${nibble28}`;
  const match28 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 28').get(prefix28);
  if (match28) return match28.vendor_name;

  // Try 24-bit (first 3 octets): AA:BB:CC
  const prefix24 = `${octets[0]}:${octets[1]}:${octets[2]}`;
  const match24 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 24').get(prefix24);
  if (match24) return match24.vendor_name;

  return null;
}

/**
 * Look up the short vendor name for a MAC address.
 * Used for generating fallback hostnames like "cisco-device".
 * @param {string} mac - MAC address in XX:XX:XX:XX:XX:XX format
 * @returns {string|null} Short vendor name or null
 */
export function lookupShortName(mac) {
  if (!mac) return null;

  const db = getDb();
  const upper = mac.toUpperCase();
  const octets = upper.split(':');
  if (octets.length !== 6) return null;

  const nibble36 = octets[4].charAt(0) + '0';
  const prefix36 = `${octets[0]}:${octets[1]}:${octets[2]}:${octets[3]}:${nibble36}`;
  const m36 = db.prepare('SELECT short_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 36').get(prefix36);
  if (m36?.short_name) return m36.short_name;

  const nibble28 = octets[3].charAt(0) + '0';
  const prefix28 = `${octets[0]}:${octets[1]}:${octets[2]}:${nibble28}`;
  const m28 = db.prepare('SELECT short_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 28').get(prefix28);
  if (m28?.short_name) return m28.short_name;

  const prefix24 = `${octets[0]}:${octets[1]}:${octets[2]}`;
  const m24 = db.prepare('SELECT short_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 24').get(prefix24);
  if (m24?.short_name) return m24.short_name;

  return null;
}

/**
 * Generate a fallback hostname from a MAC address vendor lookup.
 * Returns lowercase "<vendor>-device" (vendor truncated to 16 chars) or null.
 * Strips non-alphanumeric characters to produce a valid hostname label.
 */
export function generateFallbackHostname(mac) {
  const shortName = lookupShortName(mac);
  if (!shortName) return null;

  const clean = shortName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase();
  if (!clean) return null;

  return `${clean}-device`;
}

/**
 * Batch lookup vendors for multiple MACs. Returns a Map<mac, vendorName>.
 */
export function lookupVendorBatch(macs) {
  const result = new Map();
  if (!macs || macs.length === 0) return result;

  const db = getDb();

  // Check if table has data
  const count = db.prepare('SELECT COUNT(*) as cnt FROM mac_vendors').get();
  if (!count || count.cnt === 0) return result;

  const stmt24 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 24');
  const stmt28 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 28');
  const stmt36 = db.prepare('SELECT vendor_name FROM mac_vendors WHERE prefix = ? AND prefix_length = 36');

  for (const mac of macs) {
    if (!mac) continue;
    const upper = mac.toUpperCase();
    const octets = upper.split(':');
    if (octets.length !== 6) continue;

    // 36-bit
    const nibble36 = octets[4].charAt(0) + '0';
    const prefix36 = `${octets[0]}:${octets[1]}:${octets[2]}:${octets[3]}:${nibble36}`;
    const m36 = stmt36.get(prefix36);
    if (m36) { result.set(mac, m36.vendor_name); continue; }

    // 28-bit
    const nibble28 = octets[3].charAt(0) + '0';
    const prefix28 = `${octets[0]}:${octets[1]}:${octets[2]}:${nibble28}`;
    const m28 = stmt28.get(prefix28);
    if (m28) { result.set(mac, m28.vendor_name); continue; }

    // 24-bit
    const prefix24 = `${octets[0]}:${octets[1]}:${octets[2]}`;
    const m24 = stmt24.get(prefix24);
    if (m24) { result.set(mac, m24.vendor_name); }
  }

  return result;
}

/**
 * Start the vendor DB refresh scheduler.
 * Refreshes immediately if table is empty, then every 24 hours.
 */
export function startVendorScheduler() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as cnt FROM mac_vendors').get();

  if (!count || count.cnt === 0) {
    // Empty table — refresh immediately
    refreshVendorDb();
  } else {
    // Table has data — schedule refresh after 24h
    console.log(`MAC vendor DB: ${count.cnt} entries loaded, next refresh in 24h`);
  }

  refreshTimer = setInterval(refreshVendorDb, REFRESH_INTERVAL);
  return refreshTimer;
}

export function stopVendorScheduler() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
