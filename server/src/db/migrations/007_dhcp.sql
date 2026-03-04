-- Phase 4: DHCP scopes, reservations, and lease tracking

-- DHCP scopes extend DHCP Pool ranges with DHCP-specific options
CREATE TABLE IF NOT EXISTS dhcp_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  range_id INTEGER NOT NULL UNIQUE,
  subnet_id INTEGER NOT NULL,
  lease_time TEXT NOT NULL DEFAULT '24h',
  dns_servers TEXT,
  domain_name TEXT,
  gateway TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (range_id) REFERENCES ranges(id) ON DELETE CASCADE,
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE
);

-- DHCP reservations (MAC to IP fixed assignments)
CREATE TABLE IF NOT EXISTS dhcp_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  mac_address TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  hostname TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  UNIQUE(subnet_id, mac_address),
  UNIQUE(subnet_id, ip_address)
);

-- DHCP leases (synced from dnsmasq lease file)
CREATE TABLE IF NOT EXISTS dhcp_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  hostname TEXT,
  client_id TEXT,
  expires_at TEXT NOT NULL,
  subnet_id INTEGER,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dhcp_scopes_subnet ON dhcp_scopes(subnet_id);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_subnet ON dhcp_reservations(subnet_id);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_mac ON dhcp_reservations(mac_address);
CREATE INDEX IF NOT EXISTS idx_dhcp_leases_mac ON dhcp_leases(mac_address);
CREATE INDEX IF NOT EXISTS idx_dhcp_leases_ip ON dhcp_leases(ip_address);
