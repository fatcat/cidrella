-- Rename system range type "DHCP Pool" to "DHCP Scope"
UPDATE range_types SET name = 'DHCP Scope', description = 'Dynamic DHCP allocation scope' WHERE name = 'DHCP Pool' AND is_system = 1;
