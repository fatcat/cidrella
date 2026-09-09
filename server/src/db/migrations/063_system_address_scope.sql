-- The system allocation is reserved for topology-defined non-host addresses:
-- IPv4 network/broadcast and IPv6 subnet-router anycast. CIDRella interface
-- addresses follow the same protocol ownership as any other host address.

-- Repair any topology gateway row that was historically classified as system.
UPDATE ip_addresses
SET allocation_state = 'gateway',
    allocation_source_type = 'topology',
    allocation_source_id = subnet_id,
    reservation_note = 'Protected gateway address',
    detection_source = 'topology',
    updated_at = datetime('now')
WHERE allocation_state = 'system'
  AND EXISTS (
    SELECT 1
    FROM subnets subnet
    WHERE subnet.id = ip_addresses.subnet_id
      AND subnet.gateway_address = ip_addresses.ip_address
  );

-- A non-topology system row backed by an enabled manual address record is an
-- ordinary static DNS allocation. The DNS claim is also what excludes it from
-- DHCP pools and leases.
UPDATE ip_addresses
SET allocation_state = 'static_dns',
    allocation_source_type = 'dns',
    allocation_source_id = (
      SELECT record.id
      FROM dns_records record
      JOIN dns_zones zone ON zone.id = record.zone_id
      WHERE record.value = ip_addresses.ip_address
        AND record.type IN ('A', 'AAAA')
        AND record.enabled = 1
        AND zone.enabled = 1
        AND zone.type = 'forward'
        AND COALESCE(record.source, 'manual') = 'manual'
      ORDER BY record.id
      LIMIT 1
    ),
    hostname = (
      SELECT CASE WHEN record.name = '@' THEN zone.name
                  ELSE record.name || '.' || zone.name END
      FROM dns_records record
      JOIN dns_zones zone ON zone.id = record.zone_id
      WHERE record.value = ip_addresses.ip_address
        AND record.type IN ('A', 'AAAA')
        AND record.enabled = 1
        AND zone.enabled = 1
        AND zone.type = 'forward'
        AND COALESCE(record.source, 'manual') = 'manual'
      ORDER BY record.id
      LIMIT 1
    ),
    reservation_note = NULL,
    detection_source = 'dns',
    updated_at = datetime('now')
WHERE allocation_state = 'system'
  AND NOT EXISTS (
    SELECT 1
    FROM subnets subnet
    WHERE subnet.id = ip_addresses.subnet_id
      AND ip_addresses.ip_address IN (subnet.network_address, subnet.broadcast_address)
  )
  AND EXISTS (
    SELECT 1
    FROM dns_records record
    JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE record.value = ip_addresses.ip_address
      AND record.type IN ('A', 'AAAA')
      AND record.enabled = 1
      AND zone.enabled = 1
      AND zone.type = 'forward'
      AND COALESCE(record.source, 'manual') = 'manual'
  );

-- Rows with neither topology nor protocol ownership become unassigned. Keep
-- liveness and learned MAC metadata. Normal retirement rules own their cleanup.
UPDATE ip_addresses
SET allocation_state = 'unassigned',
    allocation_source_type = NULL,
    allocation_source_id = NULL,
    hostname = NULL,
    reservation_note = NULL,
    detection_source = NULL,
    updated_at = datetime('now')
WHERE allocation_state = 'system'
  AND NOT EXISTS (
    SELECT 1
    FROM subnets subnet
    WHERE subnet.id = ip_addresses.subnet_id
      AND ip_addresses.ip_address IN (subnet.network_address, subnet.broadcast_address)
  );
