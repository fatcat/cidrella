-- Make interface context part of canonical IP identity. The legacy table-level
-- UNIQUE(subnet_id, ip_address) constraint cannot be dropped in place, so both
-- the parent table and its ip_events child are rebuilt. Copying the child first
-- prevents ON DELETE CASCADE from discarding lifecycle history when the old
-- parent table is removed.

CREATE TABLE ip_addresses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  hostname TEXT,
  mac_address TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available','assigned','locked','dhcp')),
  range_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_seen_mac TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  reservation_note TEXT,
  scan_enabled INTEGER DEFAULT NULL,
  first_seen_at TEXT,
  last_scanned_at TEXT,
  is_rogue INTEGER NOT NULL DEFAULT 0,
  rogue_reason TEXT,
  detection_source TEXT,
  allocation_state TEXT NOT NULL DEFAULT 'unassigned'
    CHECK(allocation_state IN (
      'unassigned', 'reserved', 'static_dns', 'dynamic_dhcp', 'static_dhcp',
      'slaac', 'system', 'gateway', 'quarantined'
    )),
  allocation_source_type TEXT,
  allocation_source_id INTEGER,
  address_family INTEGER CHECK(address_family IN (4, 6)),
  address_sort_key TEXT,
  interface_id TEXT,
  preferred_until TEXT,
  valid_until TEXT,
  dhcp_version INTEGER CHECK(dhcp_version IN (4, 6)),
  offline_since_at TEXT,
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  FOREIGN KEY (range_id) REFERENCES ranges(id) ON DELETE SET NULL
);

INSERT INTO ip_addresses_new (
  id, subnet_id, ip_address, hostname, mac_address, description, status,
  range_id, created_at, updated_at, last_seen_at, last_seen_mac, is_online,
  reservation_note, scan_enabled, first_seen_at, last_scanned_at, is_rogue,
  rogue_reason, detection_source, allocation_state, allocation_source_type,
  allocation_source_id, address_family, address_sort_key, interface_id,
  preferred_until, valid_until, dhcp_version, offline_since_at
)
SELECT
  id, subnet_id, ip_address, hostname, mac_address, description, status,
  range_id, created_at, updated_at, last_seen_at, last_seen_mac, is_online,
  reservation_note, scan_enabled, first_seen_at, last_scanned_at, is_rogue,
  rogue_reason, detection_source, allocation_state, allocation_source_type,
  allocation_source_id, address_family, address_sort_key, interface_id,
  preferred_until, valid_until, dhcp_version, offline_since_at
FROM ip_addresses;

CREATE TABLE ip_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address_id INTEGER NOT NULL,
  subnet_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ip_address_id) REFERENCES ip_addresses_new(id) ON DELETE CASCADE
);

INSERT INTO ip_events_new (
  id, ip_address_id, subnet_id, ip_address, event_type,
  old_value, new_value, source, created_at
)
SELECT
  id, ip_address_id, subnet_id, ip_address, event_type,
  old_value, new_value, source, created_at
FROM ip_events;

DROP TABLE ip_events;
DROP TABLE ip_addresses;
ALTER TABLE ip_addresses_new RENAME TO ip_addresses;
ALTER TABLE ip_events_new RENAME TO ip_events;

CREATE INDEX idx_ip_addresses_subnet ON ip_addresses(subnet_id);
CREATE INDEX idx_ip_addresses_status ON ip_addresses(status);
CREATE INDEX idx_ip_addresses_rogue
  ON ip_addresses(subnet_id) WHERE is_rogue = 1;
CREATE INDEX idx_ip_addresses_allocation
  ON ip_addresses(subnet_id, allocation_state);
CREATE INDEX idx_ip_addresses_canonical_sort
  ON ip_addresses(address_family, address_sort_key, subnet_id, interface_id);
CREATE INDEX idx_ip_addresses_offline_retirement
  ON ip_addresses(is_online, offline_since_at, allocation_state);

-- COALESCE makes NULL a real identity component. A normal UNIQUE constraint
-- would allow duplicate global/unscoped rows because SQLite treats NULL values
-- as distinct, while scoped link-local rows remain distinct by interface.
CREATE UNIQUE INDEX idx_ip_addresses_identity
  ON ip_addresses(subnet_id, ip_address, COALESCE(interface_id, ''));

CREATE INDEX idx_ip_events_ip ON ip_events(ip_address_id);
CREATE INDEX idx_ip_events_subnet_time ON ip_events(subnet_id, created_at);
CREATE INDEX idx_ip_events_type ON ip_events(event_type, created_at);
