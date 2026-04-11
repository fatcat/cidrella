/**
 * MAC address vendor lookup using the Wireshark manuf database.
 * Downloads and refreshes the OUI database every 24 hours.
 */

import { getDb } from '../db/init.js';

const MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

let refreshTimer = null;

// ── Shared MAC prefix helpers ──────────────────────────────────────────────────

/**
 * Parse a MAC address string into an array of 6 uppercase octet strings.
 * Returns null if the format is not valid (must be XX:XX:XX:XX:XX:XX).
 */
function parseMacOctets(mac) {
  if (!mac) return null;
  const upper = mac.toUpperCase();
  const octets = upper.split(':');
  if (octets.length !== 6) return null;
  return octets;
}

/**
 * Build the 24-bit, 28-bit, and 36-bit OUI prefix strings from parsed octets.
 * All three are in the colon-separated format used by mac_vendors.prefix.
 */
function buildPrefixes(octets) {
  const prefix24 = `${octets[0]}:${octets[1]}:${octets[2]}`;
  const prefix28 = `${octets[0]}:${octets[1]}:${octets[2]}:${octets[3].charAt(0)}0`;
  const prefix36 = `${octets[0]}:${octets[1]}:${octets[2]}:${octets[3]}:${octets[4].charAt(0)}0`;
  return { prefix24, prefix28, prefix36 };
}

/**
 * Look up a single column value by trying 36-bit, 28-bit, then 24-bit prefixes.
 * Returns the matched value or null.
 */
function lookupByPrefixes(db, prefixes, column) {
  const r36 = db.prepare(`SELECT ${column} FROM mac_vendors WHERE prefix = ? AND prefix_length = 36`).get(prefixes.prefix36);
  if (r36?.[column]) return r36[column];

  const r28 = db.prepare(`SELECT ${column} FROM mac_vendors WHERE prefix = ? AND prefix_length = 28`).get(prefixes.prefix28);
  if (r28?.[column]) return r28[column];

  const r24 = db.prepare(`SELECT ${column} FROM mac_vendors WHERE prefix = ? AND prefix_length = 24`).get(prefixes.prefix24);
  return r24?.[column] ?? null;
}

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
  const octets = parseMacOctets(mac);
  if (!octets) return null;
  return lookupByPrefixes(getDb(), buildPrefixes(octets), 'vendor_name');
}

/**
 * Look up the short vendor name for a MAC address.
 * Used for generating fallback hostnames like "cisco-device".
 * @param {string} mac - MAC address in XX:XX:XX:XX:XX:XX format
 * @returns {string|null} Short vendor name or null
 */
export function lookupShortName(mac) {
  const octets = parseMacOctets(mac);
  if (!octets) return null;
  return lookupByPrefixes(getDb(), buildPrefixes(octets), 'short_name');
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

  for (const mac of macs) {
    const octets = parseMacOctets(mac);
    if (!octets) continue;
    const vendor = lookupByPrefixes(db, buildPrefixes(octets), 'vendor_name');
    if (vendor) result.set(mac, vendor);
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
