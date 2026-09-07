-- Interface context is part of identity only for IPv6 link-local addresses.
-- DHCPv6 client identity belongs on the canonical allocation aggregate so a
-- future live lease adapter cannot discard the DUID/IAID it validated.
ALTER TABLE ip_addresses ADD COLUMN dhcp_duid TEXT;
ALTER TABLE ip_addresses ADD COLUMN dhcp_iaid TEXT;

CREATE TRIGGER ip_addresses_interface_scope_insert
BEFORE INSERT ON ip_addresses
WHEN (
  NEW.interface_id IS NOT NULL
  AND NOT (NEW.address_family = 6 AND lower(NEW.ip_address) GLOB 'fe[89ab]*')
) OR (
  NEW.address_family = 6
  AND lower(NEW.ip_address) GLOB 'fe[89ab]*'
  AND COALESCE(trim(NEW.interface_id), '') = ''
)
BEGIN
  SELECT RAISE(ABORT, 'interface context is required only for IPv6 link-local addresses');
END;

CREATE TRIGGER ip_addresses_interface_scope_update
BEFORE UPDATE OF ip_address, address_family, interface_id ON ip_addresses
WHEN (
  NEW.interface_id IS NOT NULL
  AND NOT (NEW.address_family = 6 AND lower(NEW.ip_address) GLOB 'fe[89ab]*')
) OR (
  NEW.address_family = 6
  AND lower(NEW.ip_address) GLOB 'fe[89ab]*'
  AND COALESCE(trim(NEW.interface_id), '') = ''
)
BEGIN
  SELECT RAISE(ABORT, 'interface context is required only for IPv6 link-local addresses');
END;
