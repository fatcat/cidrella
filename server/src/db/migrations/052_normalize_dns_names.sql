-- Canonicalize DNS names in storage, so the FQDN a query builds as
-- `r.name || '.' || z.name` is correct by construction.
--
-- Why: SQLite compares TEXT with `=` case-sensitively. utils/ip-sync.js
-- reconcileDnsOrphans matches an ip_addresses.hostname against that concatenation,
-- while the JS builder (models/dns-record.js fqdnForRecordName) lowercases the
-- record name. A record written from a device-reported lease hostname such as
-- "S24-Ultra" therefore produced "S24-Ultra.example.com" from SQL and
-- "s24-ultra.example.com" from JS, the two never matched, and the reaper stripped
-- the hostname off an address whose A record was still present and still pointing
-- at it. The DHCP and reservation sync paths wrote those names raw.
--
-- Writers are now normalized at the sink (models/dns-record.js
-- normalizeRecordNameForZone, models/dns-zone.js normalizeZoneName). This repairs
-- rows written before that. Idempotent: re-running changes nothing.
--
-- See REVIEW.md, duplicate-logic audit #8.

-- 1. Zone names to lowercase.
--
-- dns_zones.name is UNIQUE, so a pair differing only by case would collide.
-- Skip any zone whose lowercase form is already taken by a different row rather
-- than failing the migration and blocking boot. Such a pair cannot be created
-- through the API (the create route rejects a duplicate name) and none existed
-- in the field, but a hand-edited database must not brick the appliance.
UPDATE dns_zones
   SET name = lower(name)
 WHERE name <> lower(name)
   AND NOT EXISTS (
     SELECT 1 FROM dns_zones other
      WHERE other.id <> dns_zones.id
        AND other.name = lower(dns_zones.name)
   );

-- 2. subnets.domain_name is a by-name pointer at a forward zone, so it has to
-- move in lockstep or every subnet silently detaches from its zone.
UPDATE subnets
   SET domain_name = lower(domain_name)
 WHERE domain_name IS NOT NULL
   AND domain_name <> lower(domain_name);

-- 3. Record names to lowercase. '@' is already lowercase and unaffected.
UPDATE dns_records
   SET name = lower(name)
 WHERE name <> lower(name);

-- 4. Strip a zone suffix a record name carries redundantly, so
-- `r.name || '.' || z.name` cannot double it up. Guarded against collapsing a
-- name to empty (a record literally named after its own zone becomes '@').
UPDATE dns_records
   SET name = '@'
 WHERE name = (SELECT lower(z.name) FROM dns_zones z WHERE z.id = dns_records.zone_id);

UPDATE dns_records
   SET name = substr(
         name,
         1,
         length(name) - length((SELECT z.name FROM dns_zones z WHERE z.id = dns_records.zone_id)) - 1
       )
 WHERE name LIKE '%.' || (SELECT lower(z.name) FROM dns_zones z WHERE z.id = dns_records.zone_id);
