-- Rogue DHCP server detection: user allowlist + detected-server events.

-- Servers the operator has authorized (in addition to CIDRella's own LAN IPs,
-- which are always auto-trusted and not stored here).
CREATE TABLE IF NOT EXISTS dhcp_authorized_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_ip TEXT NOT NULL,
  server_mac TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (server_ip)
);

-- Detected DHCP servers that were NOT authorized. Deduped on (server_ip,
-- server_mac); a re-detection bumps last_seen_at/times_seen and refreshes the
-- offered_* fields but leaves `acknowledged` alone (a persistent rogue stays
-- acknowledged once silenced — clear it to re-arm). server_mac is stored as ''
-- when unknown so the UNIQUE/upsert key never sees a NULL.
CREATE TABLE IF NOT EXISTS rogue_dhcp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_ip TEXT NOT NULL,
  server_mac TEXT NOT NULL DEFAULT '',
  server_identifier TEXT,
  offered_ip TEXT,
  offered_gateway TEXT,
  offered_dns TEXT,
  offered_subnet_mask TEXT,
  iface TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  times_seen INTEGER NOT NULL DEFAULT 1,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  UNIQUE (server_ip, server_mac)
);

CREATE INDEX IF NOT EXISTS idx_rogue_dhcp_ack_seen ON rogue_dhcp_events(acknowledged, last_seen_at);
