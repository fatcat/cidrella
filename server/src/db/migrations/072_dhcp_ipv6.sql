-- DHCPv6. A scope records its address family and, for IPv6, its mode:
-- slaac (Router Advertisement only), stateless (SLAAC plus stateless DHCPv6
-- for options), or stateful (managed addresses from a pool). DHCPv6 clients
-- are identified by DUID and IAID rather than MAC, so reservations and leases
-- gain those columns and the MAC becomes optional. Option tables gain an
-- address family inside their unique keys because DHCPv4 and DHCPv6 option
-- codes are separate namespaces (v4 option 23 is default TTL, v6 option 23 is
-- the DNS server list). No IPv6 option rows are written yet; every existing
-- reader continues to see family-4 rows only.
--
-- Runs under the foreign-keys-off procedure in runMigrations.

ALTER TABLE dhcp_scopes ADD COLUMN address_family INTEGER NOT NULL DEFAULT 4
  CHECK(address_family IN (4, 6));
ALTER TABLE dhcp_scopes ADD COLUMN v6_mode TEXT
  CHECK(v6_mode IS NULL OR v6_mode IN ('slaac', 'stateless', 'stateful'));

CREATE TABLE dhcp_reservations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  mac_address TEXT,
  ip_address TEXT NOT NULL,
  hostname TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  duid TEXT,
  iaid INTEGER,
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE,
  UNIQUE(subnet_id, mac_address),
  UNIQUE(subnet_id, duid),
  UNIQUE(subnet_id, ip_address),
  CHECK(
    (address_family = 4 AND mac_address IS NOT NULL)
    OR (address_family = 6 AND duid IS NOT NULL)
  )
);

INSERT INTO dhcp_reservations_new (
  id, subnet_id, mac_address, ip_address, hostname, description, enabled,
  created_at, updated_at, address_family, duid, iaid
)
SELECT
  id, subnet_id, mac_address, ip_address, hostname, description, enabled,
  created_at, updated_at, 4, NULL, NULL
FROM dhcp_reservations;

DROP TABLE dhcp_reservations;
ALTER TABLE dhcp_reservations_new RENAME TO dhcp_reservations;

CREATE INDEX idx_dhcp_reservations_subnet ON dhcp_reservations(subnet_id);
CREATE INDEX idx_dhcp_reservations_mac ON dhcp_reservations(mac_address);
CREATE INDEX idx_dhcp_reservations_duid ON dhcp_reservations(duid);

CREATE TABLE dhcp_leases_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  mac_address TEXT,
  hostname TEXT,
  client_id TEXT,
  expires_at TEXT NOT NULL,
  subnet_id INTEGER,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  dhcp_version INTEGER NOT NULL DEFAULT 4 CHECK(dhcp_version IN (4, 6)),
  duid TEXT,
  iaid INTEGER,
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE SET NULL
);

INSERT INTO dhcp_leases_new (
  id, ip_address, mac_address, hostname, client_id, expires_at, subnet_id,
  last_seen, dhcp_version, duid, iaid
)
SELECT
  id, ip_address, mac_address, hostname, client_id, expires_at, subnet_id,
  last_seen, 4, NULL, NULL
FROM dhcp_leases;

DROP TABLE dhcp_leases;
ALTER TABLE dhcp_leases_new RENAME TO dhcp_leases;

CREATE INDEX idx_dhcp_leases_mac ON dhcp_leases(mac_address);
CREATE INDEX idx_dhcp_leases_ip ON dhcp_leases(ip_address);
CREATE INDEX idx_dhcp_leases_duid ON dhcp_leases(duid);

CREATE TABLE dhcp_scope_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  option_code INTEGER NOT NULL,
  value TEXT NOT NULL,
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  UNIQUE(scope_id, address_family, option_code)
);
INSERT INTO dhcp_scope_options_new (id, scope_id, option_code, value, address_family)
  SELECT id, scope_id, option_code, value, 4 FROM dhcp_scope_options;
DROP TABLE dhcp_scope_options;
ALTER TABLE dhcp_scope_options_new RENAME TO dhcp_scope_options;
CREATE INDEX idx_scope_options_scope ON dhcp_scope_options(scope_id);

CREATE TABLE dhcp_option_defaults_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_code INTEGER NOT NULL,
  value TEXT,
  enabled_by_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  UNIQUE(address_family, option_code)
);
INSERT INTO dhcp_option_defaults_new
  (id, option_code, value, enabled_by_default, updated_at, address_family)
  SELECT id, option_code, value, enabled_by_default, updated_at, 4 FROM dhcp_option_defaults;
DROP TABLE dhcp_option_defaults;
ALTER TABLE dhcp_option_defaults_new RENAME TO dhcp_option_defaults;

CREATE TABLE dhcp_custom_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  UNIQUE(address_family, code)
);
INSERT INTO dhcp_custom_options_new
  (id, code, name, label, type, description, created_at, address_family)
  SELECT id, code, name, label, type, description, created_at, 4 FROM dhcp_custom_options;
DROP TABLE dhcp_custom_options;
ALTER TABLE dhcp_custom_options_new RENAME TO dhcp_custom_options;
