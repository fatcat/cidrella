-- IPv6 networks. A network row records its address family. IPv6 has no
-- broadcast address, and a /64 holds more addresses than an INTEGER column or
-- a JavaScript number represents, so broadcast_address and total_addresses
-- become nullable and last_address carries the top of the prefix for both
-- families. SQLite cannot drop NOT NULL in place, so the table is rebuilt.
--
-- This migration runs under the foreign-keys-off procedure in runMigrations.
-- Dropping subnets with foreign keys enforced would cascade into ranges,
-- ip_addresses, dhcp_scopes, dhcp_reservations and network_scans.

CREATE TABLE subnets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cidr TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  vlan_id INTEGER,
  network_address TEXT NOT NULL,
  broadcast_address TEXT,
  prefix_length INTEGER NOT NULL,
  total_addresses INTEGER,
  gateway_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_id INTEGER REFERENCES subnets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'allocated' CHECK(status IN ('unallocated', 'allocated')),
  depth INTEGER NOT NULL DEFAULT 0,
  has_reverse_dns INTEGER NOT NULL DEFAULT 0,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  scan_interval TEXT DEFAULT NULL,
  domain_name TEXT,
  scan_enabled INTEGER DEFAULT NULL,
  gateway_policy TEXT NOT NULL DEFAULT 'none'
    CHECK(gateway_policy IN ('first', 'last', 'custom', 'none')),
  topology_revision INTEGER NOT NULL DEFAULT 1,
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  last_address TEXT
);

INSERT INTO subnets_new (
  id, cidr, name, description, vlan_id, network_address, broadcast_address,
  prefix_length, total_addresses, gateway_address, created_at, updated_at,
  parent_id, status, depth, has_reverse_dns, folder_id, scan_interval,
  domain_name, scan_enabled, gateway_policy, topology_revision,
  address_family, last_address
)
SELECT
  id, cidr, name, description, vlan_id, network_address, broadcast_address,
  prefix_length, total_addresses, gateway_address, created_at, updated_at,
  parent_id, status, depth, has_reverse_dns, folder_id, scan_interval,
  domain_name, scan_enabled, gateway_policy, topology_revision,
  4, broadcast_address
FROM subnets;

DROP TABLE subnets;
ALTER TABLE subnets_new RENAME TO subnets;

CREATE INDEX idx_subnets_parent ON subnets(parent_id);
CREATE INDEX idx_subnets_status ON subnets(status);
CREATE INDEX idx_subnets_folder ON subnets(folder_id);
CREATE INDEX idx_subnets_family ON subnets(address_family);
