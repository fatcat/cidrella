-- Decouple DNS zones from subnets.
--
-- Historically `dns_zones.subnet_id` was a 1:1 FK to subnets. It created
-- cascading edge cases every time a subnet was divided, merged, or renamed:
-- a forward zone could only be "owned" by one subnet, but siblings sharing a
-- domain_name needed to share a zone. Six rounds of fixes piled compensating
-- logic (migrateParentZonesToChildren, detectForwardZoneConflict, sibling
-- zone-reassignment on delete, bidirectional subnets.domain_name sync, etc).
--
-- Post-decouple: zones are DNS objects, subnets are IPAM objects. They relate
-- only through the hostname↔IP semantic (forward via `subnets.domain_name`,
-- reverse via octet-reversal of the IP). Any subnet can write PTRs into any
-- reverse zone covering the IP; multiple subnets can reference the same
-- forward zone via shared `domain_name`.
--
-- This rebuilds the table to drop the `subnet_id` column and its FK/index.
-- `folder_id` FK is preserved.

CREATE TABLE dns_zones_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('forward', 'reverse')),
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  soa_primary_ns TEXT DEFAULT 'ns1.localhost',
  soa_admin_email TEXT DEFAULT 'admin.localhost',
  soa_serial INTEGER DEFAULT 1,
  soa_refresh INTEGER DEFAULT 3600,
  soa_retry INTEGER DEFAULT 900,
  soa_expire INTEGER DEFAULT 604800,
  soa_minimum_ttl INTEGER DEFAULT 86400,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL
);

INSERT INTO dns_zones_new
  (id, name, type, description, enabled, created_at, updated_at,
   soa_primary_ns, soa_admin_email, soa_serial, soa_refresh, soa_retry,
   soa_expire, soa_minimum_ttl, folder_id)
SELECT
   id, name, type, description, enabled, created_at, updated_at,
   soa_primary_ns, soa_admin_email, soa_serial, soa_refresh, soa_retry,
   soa_expire, soa_minimum_ttl, folder_id
FROM dns_zones;

DROP INDEX IF EXISTS idx_dns_zones_subnet;
DROP TABLE dns_zones;
ALTER TABLE dns_zones_new RENAME TO dns_zones;
