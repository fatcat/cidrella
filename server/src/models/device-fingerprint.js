// Data access for passive device/OS fingerprints (keyed by MAC). Mirrors the
// batch-lookup shape of mac-vendor.js so the IP-view enrichment can attach
// device metadata the same way it attaches the OUI vendor.


// Fields worth flagging when they drift on an existing, already-classified
// device. dhcp_fingerprint (option 55) is excluded: its exact parameter
// list can vary transaction to transaction even for the same device, which
// would make it too noisy a signal. A manual override's fields never drift
// here since upsertFingerprint keeps them sticky against fresh DHCP data.
const DRIFT_FIELDS = ['device_type', 'os_family', 'vendor_class'];

function logDrift(db, mac, before, after) {
  if (!before) return; // first-ever classification isn't drift
  const insert = db.prepare(`
    INSERT INTO device_fingerprint_changes (mac_address, field, previous_value, new_value)
    VALUES (?, ?, ?, ?)
  `);
  for (const field of DRIFT_FIELDS) {
    const prev = before[field];
    const next = after[field];
    if (prev && next && prev !== next) {
      insert.run(mac, field, prev, next);
    }
  }
}

// Insert or refresh a fingerprint. A 'manual' override is never clobbered by a
// later 'dhcp' capture, we still bump last_seen_at and refresh the raw DHCP
// signals, but keep the operator-set type/os/source. Any drift on an
// already-classified device is logged to device_fingerprint_changes before
// being overwritten.
export function upsertFingerprint(db, fp) {
  const mac = String(fp.mac_address).toLowerCase();
  const before = getByMac(db, mac);
  if (before && before.source !== 'manual') {
    logDrift(db, mac, before, {
      device_type: fp.device_type ?? null,
      os_family: fp.os_family ?? null,
      vendor_class: fp.vendor_class ?? null,
    });
  }
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
    mac_address: mac,
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

// Recent fingerprint drift for a MAC, newest first. Each row is one changed
// field (device_type/os_family/vendor_class), not one DHCP transaction.
export function getFingerprintChanges(db, mac, days = 90) {
  if (!mac) return [];
  return db.prepare(`
    SELECT field, previous_value, new_value, changed_at
    FROM device_fingerprint_changes
    WHERE mac_address = ? AND changed_at >= datetime('now', '-' || ? || ' days')
    ORDER BY changed_at DESC
  `).all(String(mac).toLowerCase(), Math.max(1, Math.min(365, Number(days) || 90)));
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

// Undo an operator override. Deletes the whole row rather than flipping
// source back to 'dhcp': the raw DHCP signals are re-captured and
// re-classified on the device's next DHCP transaction, so deletion is the
// clean path back to auto-classification (upsertFingerprint keeps 'manual'
// sticky, so an in-place flip would need re-derivation logic here instead).
export function clearManual(db, mac) {
  return db.prepare(
    "DELETE FROM device_fingerprints WHERE mac_address = ? AND source = 'manual'"
  ).run(String(mac).toLowerCase());
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
