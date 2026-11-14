-- A scope hands out its network's gateway (subnets.gateway_address) as the
-- router, or none when the network has none, so this column was never served.
-- Nothing kept it current either: a network's gateway edit left it behind, and
-- it could show an address that does not answer. IPv4 only: a DHCPv6 scope
-- never had a gateway, its clients learn routers from Router Advertisements.
ALTER TABLE dhcp_scopes DROP COLUMN gateway;
