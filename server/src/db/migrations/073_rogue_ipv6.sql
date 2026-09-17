-- Rogue detection for IPv6: DHCPv6 servers and Router Advertisements.
--
-- rogue_dhcp_events gains the protocol that produced the event (`kind`), the
-- address family, the DHCPv6 server DUID and, for Router Advertisements, the
-- prefixes the router announced. The dedup key widens to include `kind`: one
-- host that answers DHCPv6 and also sends RAs is two findings, not one row
-- that flips between them on every probe.
--
-- dhcp_authorized_servers can now trust a server by IP (either family), MAC
-- or DUID. server_ip becomes nullable, with a CHECK that at least one identity
-- is present. A DHCPv6 server is identified by its DUID and an RA sender by
-- its MAC, so an IP-only allowlist cannot describe either.
--
-- Neither table is referenced by a foreign key, so dropping the old copies
-- cascades into nothing.

CREATE TABLE rogue_dhcp_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'dhcp' CHECK (kind IN ('dhcp', 'dhcpv6', 'ra')),
  address_family INTEGER NOT NULL DEFAULT 4 CHECK (address_family IN (4, 6)),
  server_ip TEXT NOT NULL,
  server_mac TEXT NOT NULL DEFAULT '',
  server_duid TEXT,
  server_identifier TEXT,
  offered_ip TEXT,
  offered_gateway TEXT,
  offered_dns TEXT,
  offered_subnet_mask TEXT,
  advertised_prefixes TEXT,
  relay_ip TEXT,
  iface TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  times_seen INTEGER NOT NULL DEFAULT 1,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  UNIQUE (kind, server_ip, server_mac)
);

INSERT INTO rogue_dhcp_events_new (
  id, server_ip, server_mac, server_identifier, offered_ip, offered_gateway,
  offered_dns, offered_subnet_mask, relay_ip, iface, first_seen_at, last_seen_at,
  times_seen, acknowledged, acknowledged_at
)
SELECT
  id, server_ip, server_mac, server_identifier, offered_ip, offered_gateway,
  offered_dns, offered_subnet_mask, relay_ip, iface, first_seen_at, last_seen_at,
  times_seen, acknowledged, acknowledged_at
FROM rogue_dhcp_events;

DROP TABLE rogue_dhcp_events;
ALTER TABLE rogue_dhcp_events_new RENAME TO rogue_dhcp_events;
CREATE INDEX IF NOT EXISTS idx_rogue_dhcp_ack_seen ON rogue_dhcp_events(acknowledged, last_seen_at);

CREATE TABLE dhcp_authorized_servers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_ip TEXT,
  server_mac TEXT,
  server_duid TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (server_ip IS NOT NULL OR server_mac IS NOT NULL OR server_duid IS NOT NULL)
);

INSERT INTO dhcp_authorized_servers_new (id, server_ip, server_mac, description, created_at)
SELECT id, server_ip, server_mac, description, created_at FROM dhcp_authorized_servers;

DROP TABLE dhcp_authorized_servers;
ALTER TABLE dhcp_authorized_servers_new RENAME TO dhcp_authorized_servers;
CREATE UNIQUE INDEX idx_dhcp_authorized_ip
  ON dhcp_authorized_servers(server_ip) WHERE server_ip IS NOT NULL;
CREATE UNIQUE INDEX idx_dhcp_authorized_duid
  ON dhcp_authorized_servers(server_duid) WHERE server_duid IS NOT NULL;
