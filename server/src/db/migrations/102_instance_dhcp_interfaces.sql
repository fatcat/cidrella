-- How many of an instance's interfaces would serve DHCP if it held DHCP, as
-- it last said (Settings > General > Interfaces on that box). Moving DHCP to
-- an instance with none is refused (services/dhcp-move.js): it would serve
-- nobody. The controller's own knowledge, like dns_state: never synced. NULL
-- until it reports (an older member), and then a move is not refused.
ALTER TABLE sync_instances ADD COLUMN dhcp_interfaces INTEGER;
