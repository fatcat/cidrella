-- Rename ip_addresses status 'reserved' → 'locked' to avoid confusion with DHCP reservations.
-- SQLite enforces CHECK constraints, so we must rebuild the table to update the allowed values.

-- 1. Create new table with updated CHECK constraint
CREATE TABLE ip_addresses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  hostname TEXT,
  mac_address TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','locked','dhcp')),
  range_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_seen_mac TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  reservation_note TEXT,
  scan_enabled INTEGER DEFAULT NULL,
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  FOREIGN KEY (range_id) REFERENCES ranges(id) ON DELETE SET NULL,
  UNIQUE(subnet_id, ip_address)
);

-- 2. Copy data, renaming 'reserved' → 'locked'
INSERT INTO ip_addresses_new
  (id, subnet_id, ip_address, hostname, mac_address, description, status, range_id,
   created_at, updated_at, last_seen_at, last_seen_mac, is_online, reservation_note, scan_enabled)
SELECT
  id, subnet_id, ip_address, hostname, mac_address, description,
  CASE WHEN status = 'reserved' THEN 'locked' ELSE status END,
  range_id, created_at, updated_at, last_seen_at, last_seen_mac, is_online,
  reservation_note, scan_enabled
FROM ip_addresses;

-- 3. Drop old table and rename
DROP TABLE ip_addresses;
ALTER TABLE ip_addresses_new RENAME TO ip_addresses;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_ip_addresses_subnet ON ip_addresses(subnet_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_status ON ip_addresses(status);
