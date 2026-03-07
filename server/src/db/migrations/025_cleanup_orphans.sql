-- Remove DNS zones referencing deleted subnets
DELETE FROM dns_zones WHERE subnet_id IS NOT NULL
  AND subnet_id NOT IN (SELECT id FROM subnets);

-- Remove orphaned DHCP leases
DELETE FROM dhcp_leases WHERE subnet_id IS NULL;
DELETE FROM dhcp_leases WHERE subnet_id IS NOT NULL
  AND subnet_id NOT IN (SELECT id FROM subnets);

-- Clear dangling vlan_id references in subnets
UPDATE subnets SET vlan_id = NULL
  WHERE vlan_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM vlans v
    WHERE v.vlan_id = subnets.vlan_id
    AND v.folder_id = subnets.folder_id
  );
