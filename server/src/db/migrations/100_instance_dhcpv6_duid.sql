-- The DUID an instance's DHCPv6 server answers with, as it last said
-- (lowercase colon-separated hex, utils/duid.js). The controller's rogue
-- DHCPv6 probe trusts an advertisement that carries one: a member serving
-- DHCP is heard from a link-local address no list holds. The controller's
-- own knowledge, like dns_state: never synced. NULL until it reports.
ALTER TABLE sync_instances ADD COLUMN dhcpv6_duid TEXT;
