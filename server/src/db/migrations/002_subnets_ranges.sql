-- Phase 2: Subnets, ranges, and range types

-- Range types (system-created are immutable, user-created have full CRUD)
CREATE TABLE IF NOT EXISTS range_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  is_system INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed system range types
INSERT INTO range_types (name, color, is_system, description) VALUES
  ('Network',   '#6b7280', 1, 'Network address (not assignable)'),
  ('Gateway',   '#f59e0b', 1, 'Default gateway address'),
  ('Broadcast', '#6b7280', 1, 'Broadcast address (not assignable)'),
  ('DHCP Pool', '#3b82f6', 1, 'Dynamic DHCP allocation pool'),
  ('Static',    '#10b981', 1, 'Statically assigned addresses');

-- Subnets
CREATE TABLE IF NOT EXISTS subnets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cidr TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  vlan_id INTEGER,
  network_address TEXT NOT NULL,
  broadcast_address TEXT NOT NULL,
  prefix_length INTEGER NOT NULL,
  total_addresses INTEGER NOT NULL,
  gateway_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Functional ranges within subnets
CREATE TABLE IF NOT EXISTS ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  range_type_id INTEGER NOT NULL,
  start_ip TEXT NOT NULL,
  end_ip TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  FOREIGN KEY (range_type_id) REFERENCES range_types(id)
);

-- IP address assignments
CREATE TABLE IF NOT EXISTS ip_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  hostname TEXT,
  mac_address TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','reserved','dhcp')),
  range_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  FOREIGN KEY (range_id) REFERENCES ranges(id) ON DELETE SET NULL,
  UNIQUE(subnet_id, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_ranges_subnet ON ranges(subnet_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_subnet ON ip_addresses(subnet_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_status ON ip_addresses(status);
