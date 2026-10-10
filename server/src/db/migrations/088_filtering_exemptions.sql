-- Hosts with DNS filtering turned off.
--
-- A row turns filtering (blocklist categories and GeoIP country rules) off
-- for one host until someone turns it back on; no row means filtering is on,
-- so the default costs nothing. A host is its device's MAC when one is known,
-- so the exemption follows a DHCP client to a new address, and its address
-- otherwise. Exactly one of the two is set.
--
-- The table stands apart from ip_addresses on purpose: an address with no
-- stored row can be exempt, and an exemption survives that row being removed
-- or moved. models/filtering-exemption.js owns every rule and every write.

CREATE TABLE IF NOT EXISTS filtering_exemptions (
  id INTEGER PRIMARY KEY,
  mac_address TEXT UNIQUE,
  ip_address TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  CHECK ((mac_address IS NULL) <> (ip_address IS NULL))
);
