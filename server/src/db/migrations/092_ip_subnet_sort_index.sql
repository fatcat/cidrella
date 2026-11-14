-- One network's addresses in address order, for the IPv6 address list that
-- pages in SQL (docs/IPV6-HANDLING.md, rule 7). The canonical sort index
-- leads with the family, so it cannot serve a per-network page. interface_id
-- breaks the tie for an address held on two interfaces, so a page boundary
-- is stable.
CREATE INDEX IF NOT EXISTS idx_ip_addresses_subnet_sort
  ON ip_addresses(subnet_id, address_sort_key, interface_id);

-- The new index leads with subnet_id, so the single-column one is redundant.
DROP INDEX IF EXISTS idx_ip_addresses_subnet;
