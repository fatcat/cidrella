-- Changelog for device fingerprint drift. device_fingerprints (049) only
-- ever held the current classification, upserted in place on every DHCP
-- transaction, so a device_type/os_family/vendor_class change was silently
-- overwritten with no trace. That's exactly the signal worth keeping: a MAC
-- that suddenly classifies as a different kind of device is a strong tell
-- for spoofing or a rogue device taking over a trusted address.
CREATE TABLE IF NOT EXISTS device_fingerprint_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac_address TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  field TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_fingerprint_changes_mac
  ON device_fingerprint_changes(mac_address, changed_at);
