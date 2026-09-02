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
SET allocation_state = CASE status
  WHEN 'locked' THEN 'reserved'
  WHEN 'assigned' THEN 'static_dns'
  WHEN 'dhcp' THEN CASE
    WHEN EXISTS (
      SELECT 1 FROM dhcp_reservations reservation
      WHERE reservation.subnet_id = ip_addresses.subnet_id
        AND reservation.ip_address = ip_addresses.ip_address
        AND reservation.enabled = 1
    ) THEN 'static_dhcp'
    WHEN EXISTS (
      SELECT 1 FROM dhcp_leases lease
      WHERE lease.subnet_id = ip_addresses.subnet_id
        AND lease.ip_address = ip_addresses.ip_address
        AND (lease.expires_at = 'infinite' OR lease.expires_at >= datetime('now'))
    ) THEN 'dynamic_dhcp'
    ELSE 'unassigned'
  END
  ELSE 'unassigned'
END;

UPDATE ip_addresses
SET allocation_source_type = CASE allocation_state
  WHEN 'reserved' THEN 'admin_reservation'
  WHEN 'static_dns' THEN 'dns'
  WHEN 'static_dhcp' THEN 'dhcp_reservation'
  WHEN 'dynamic_dhcp' THEN 'dhcp_lease'
  ELSE NULL
END;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_allocation
  ON ip_addresses(subnet_id, allocation_state);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_canonical_sort
  ON ip_addresses(address_family, address_sort_key, subnet_id, interface_id);

