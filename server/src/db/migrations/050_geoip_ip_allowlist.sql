-- GeoIP IP/CIDR allowlist: answer IPs (or ranges) here are never GeoIP-blocked,
-- regardless of the resolved country. This is the correct-granularity exemption
-- for country-based blocking (the domain whitelist in blocklist_whitelist remains
-- a separate, universal "always allow this domain" override).
CREATE TABLE IF NOT EXISTS geoip_ip_allowlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  value      TEXT NOT NULL UNIQUE,   -- single IP or CIDR, IPv4 or IPv6
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
