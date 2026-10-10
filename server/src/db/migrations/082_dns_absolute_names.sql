-- Record names follow the zone-file rule from 0.5.1 (docs/ARCHITECTURE.md,
-- Canonical IP Model): a name ending in '.' is absolute, every other name is
-- relative to its zone, dotted or not. Before, a dotted name without the dot
-- (`nas.home.lan` in zone `example.lan`) was served as absolute. Mark those
-- absolute so they keep serving exactly the name they served.
--
-- Left alone: names already ending in '.', names under their own zone
-- (normalization strips that suffix, so these should not exist), SRV names
-- (`_service._protocol`, which 0.5.1 already serves under the zone), and
-- reverse zones (PTR names are dotted octets or nibbles, always relative).
UPDATE dns_records
SET name = name || '.', updated_at = datetime('now')
WHERE name LIKE '%.%'
  AND name NOT LIKE '%.'
  AND type <> 'SRV'
  AND zone_id IN (SELECT id FROM dns_zones WHERE type = 'forward')
  AND lower(name) NOT LIKE '%.' || (SELECT lower(z.name) FROM dns_zones z WHERE z.id = dns_records.zone_id);

-- An absolute name's FQDN is now the name without its dot (fqdnForRecordName).
-- Before, a name entered with the dot kept it in the FQDN, and the copies
-- derived from it did too: the address's canonical hostname and the value of
-- the PTR generated for it. Trim those so stored facts already match what the
-- reader produces, rather than each converging on its next write. An
-- operator's own PTR (source manual) is an override and keeps its spelling.
UPDATE ip_addresses
SET hostname = substr(hostname, 1, length(hostname) - 1)
WHERE hostname LIKE '%.';

UPDATE dns_records
SET value = substr(value, 1, length(value) - 1), updated_at = datetime('now')
WHERE type = 'PTR'
  AND COALESCE(source, 'manual') <> 'manual'
  AND value LIKE '%.';
