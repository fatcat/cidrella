// Data access for passive device/OS fingerprints (keyed by MAC). Mirrors the
// batch-lookup shape of mac-vendor.js so the IP-view enrichment can attach
// device metadata the same way it attaches the OUI vendor.

import { getDb } from '../db/init.js';

// Insert or refresh a fingerprint. A 'manual' override is never clobbered by a
// later 'dhcp' capture — we still bump last_seen_at and refresh the raw DHCP
// signals, but keep the operator-set type/os/source.
export function upsertFingerprint(db, fp) {
  return db.prepare(`
    INSERT INTO device_fingerprints
      (mac_address, dhcp_fingerprint, vendor_class, dhcp_hostname,
       device_type, os_family, confidence, source, raw)
    VALUES (@mac_address, @dhcp_fingerprint, @vendor_class, @dhcp_hostname,
            @device_type, @os_family, @confidence, @source, @raw)
    ON CONFLICT(mac_address) DO UPDATE SET
      dhcp_fingerprint = excluded.dhcp_fingerprint,
      vendor_class     = excluded.vendor_class,
      dhcp_hostname    = excluded.dhcp_hostname,
      last_seen_at     = datetime('now'),
      updated_at       = datetime('now'),
      -- don't let a fresh dhcp capture overwrite a manual override
      device_type = CASE WHEN device_fingerprints.source = 'manual' THEN device_fingerprints.device_type ELSE excluded.device_type END,
      os_family   = CASE WHEN device_fingerprints.source = 'manual' THEN device_fingerprints.os_family   ELSE excluded.os_family   END,
      confidence  = CASE WHEN device_fingerprints.source = 'manual' THEN device_fingerprints.confidence  ELSE excluded.confidence  END,
      source      = device_fingerprints.source,
      raw         = excluded.raw
  `).run({
    mac_address: String(fp.mac_address).toLowerCase(),
    dhcp_fingerprint: fp.dhcp_fingerprint ?? null,
    vendor_class: fp.vendor_class ?? null,
    dhcp_hostname: fp.dhcp_hostname ?? null,
    device_type: fp.device_type ?? null,
    os_family: fp.os_family ?? null,
    confidence: Number.isInteger(fp.confidence) ? fp.confidence : 0,
    source: fp.source || 'dhcp',
    raw: fp.raw ?? null,
  });
}

export function getByMac(db, mac) {
  if (!mac) return null;
  return db.prepare('SELECT * FROM device_fingerprints WHERE mac_address = ?').get(String(mac).toLowerCase()) || null;
}

// Batch lookup → Map<mac, {device_type, os_family, confidence}>. Mirrors
// lookupVendorBatch so enrichIpViewRows can attach fields cheaply. Returns an
// empty map fast when the table is empty.
export function lookupFingerprintBatch(db, macs) {
  const result = new Map();
  if (!macs || macs.length === 0) return result;

  const count = db.prepare('SELECT COUNT(*) AS c FROM device_fingerprints').get();
  if (!count || count.c === 0) return result;

  const stmt = db.prepare('SELECT device_type, os_family, confidence FROM device_fingerprints WHERE mac_address = ?');
  for (const mac of macs) {
    if (!mac) continue;
    const row = stmt.get(String(mac).toLowerCase());
    if (row) result.set(mac, row);
  }
  return result;
}

// Operator override from the UI.
export function setManual(db, mac, { device_type, os_family }) {
  return db.prepare(`
    INSERT INTO device_fingerprints (mac_address, device_type, os_family, confidence, source)
    VALUES (?, ?, ?, 100, 'manual')
    ON CONFLICT(mac_address) DO UPDATE SET
      device_type = excluded.device_type,
      os_family   = excluded.os_family,
      confidence  = 100,
      source      = 'manual',
      updated_at  = datetime('now')
  `).run(String(mac).toLowerCase(), device_type ?? null, os_family ?? null);
}
