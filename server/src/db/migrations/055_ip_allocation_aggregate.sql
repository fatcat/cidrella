-- Canonical IP allocation aggregate. Legacy status remains during migration.
ALTER TABLE ip_addresses ADD COLUMN allocation_state TEXT NOT NULL DEFAULT 'unassigned'
  CHECK(allocation_state IN (
    'unassigned', 'reserved', 'static_dns', 'dynamic_dhcp', 'static_dhcp',
    'slaac', 'system', 'gateway', 'quarantined'
  ));
ALTER TABLE ip_addresses ADD COLUMN allocation_source_type TEXT;
ALTER TABLE ip_addresses ADD COLUMN allocation_source_id INTEGER;
ALTER TABLE ip_addresses ADD COLUMN address_family INTEGER CHECK(address_family IN (4, 6));
ALTER TABLE ip_addresses ADD COLUMN address_sort_key TEXT;
ALTER TABLE ip_addresses ADD COLUMN interface_id TEXT;
ALTER TABLE ip_addresses ADD COLUMN preferred_until TEXT;
ALTER TABLE ip_addresses ADD COLUMN valid_until TEXT;
ALTER TABLE ip_addresses ADD COLUMN dhcp_version INTEGER CHECK(dhcp_version IN (4, 6));

UPDATE ip_addresses
SET allocation_state = CASE
  WHEN EXISTS (
    SELECT 1 FROM subnets subnet
    WHERE subnet.id = ip_addresses.subnet_id
      AND ip_addresses.ip_address = subnet.gateway_address
  ) THEN 'gateway'
  WHEN EXISTS (
    SELECT 1 FROM subnets subnet
    WHERE subnet.id = ip_addresses.subnet_id
      AND ip_addresses.ip_address IN (subnet.network_address, subnet.broadcast_address)
  ) THEN 'system'
  WHEN EXISTS (
    SELECT 1 FROM dhcp_reservations reservation
    WHERE reservation.subnet_id = ip_addresses.subnet_id
      AND reservation.ip_address = ip_addresses.ip_address
      AND reservation.enabled = 1
  ) THEN 'static_dhcp'
  WHEN EXISTS (
    SELECT 1 FROM dns_records record
    JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE record.value = ip_addresses.ip_address
      AND record.type IN ('A', 'AAAA')
      AND record.enabled = 1
      AND zone.enabled = 1
      AND zone.type = 'forward'
      AND COALESCE(record.source, 'manual') = 'manual'
  ) THEN 'static_dns'
  WHEN EXISTS (
    SELECT 1 FROM dhcp_leases lease
    WHERE lease.subnet_id = ip_addresses.subnet_id
      AND lease.ip_address = ip_addresses.ip_address
      AND (lease.expires_at = 'infinite' OR datetime(lease.expires_at) > datetime('now'))
  ) THEN 'dynamic_dhcp'
  WHEN status = 'locked' THEN 'reserved'
  ELSE 'unassigned'
END;

UPDATE ip_addresses
SET allocation_source_type = CASE allocation_state
  WHEN 'reserved' THEN 'admin_reservation'
  WHEN 'static_dns' THEN 'dns'
  WHEN 'static_dhcp' THEN 'dhcp_reservation'
  WHEN 'dynamic_dhcp' THEN 'dhcp_lease'
  WHEN 'system' THEN 'topology'
  WHEN 'gateway' THEN 'topology'
  ELSE NULL
END;

UPDATE ip_addresses
SET allocation_source_id = CASE allocation_state
  WHEN 'static_dns' THEN (
    SELECT record.id FROM dns_records record
    JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE record.value = ip_addresses.ip_address
      AND record.type IN ('A', 'AAAA')
      AND record.enabled = 1 AND zone.enabled = 1
      AND zone.type = 'forward'
      AND COALESCE(record.source, 'manual') = 'manual'
    ORDER BY record.id LIMIT 1
  )
  WHEN 'static_dhcp' THEN (
    SELECT reservation.id FROM dhcp_reservations reservation
    WHERE reservation.subnet_id = ip_addresses.subnet_id
      AND reservation.ip_address = ip_addresses.ip_address
      AND reservation.enabled = 1
    ORDER BY reservation.id LIMIT 1
  )
  WHEN 'dynamic_dhcp' THEN (
    SELECT lease.id FROM dhcp_leases lease
    WHERE lease.subnet_id = ip_addresses.subnet_id
      AND lease.ip_address = ip_addresses.ip_address
      AND (lease.expires_at = 'infinite' OR datetime(lease.expires_at) > datetime('now'))
    ORDER BY CASE WHEN lease.expires_at = 'infinite' THEN 1 ELSE 0 END DESC,
             datetime(lease.expires_at) DESC, lease.id DESC LIMIT 1
  )
  WHEN 'system' THEN subnet_id
  WHEN 'gateway' THEN subnet_id
  ELSE NULL
END;

UPDATE ip_addresses
SET status = CASE allocation_state
      WHEN 'static_dns' THEN 'assigned'
      WHEN 'static_dhcp' THEN 'dhcp'
      WHEN 'dynamic_dhcp' THEN 'dhcp'
      WHEN 'reserved' THEN 'locked'
      WHEN 'system' THEN 'locked'
      WHEN 'gateway' THEN 'locked'
      ELSE 'available'
    END,
    dhcp_version = CASE
      WHEN allocation_state IN ('static_dhcp', 'dynamic_dhcp') THEN 4
      ELSE NULL
    END,
    is_rogue = CASE WHEN allocation_state = 'unassigned' THEN is_rogue ELSE 0 END,
    rogue_reason = CASE WHEN allocation_state = 'unassigned' THEN rogue_reason ELSE NULL END,
    detection_source = CASE
      WHEN allocation_state = 'unassigned'
       AND detection_source IN ('dns', 'dhcp_lease', 'dhcp_reservation') THEN NULL
      ELSE detection_source
    END;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_allocation
  ON ip_addresses(subnet_id, allocation_state);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_canonical_sort
  ON ip_addresses(address_family, address_sort_key, subnet_id, interface_id);
