-- Count DHCP messages per family so the dashboard can draw DHCPv4 and DHCPv6
-- on their own charts. The combined columns (dhcp_requests, dhcp_client_msgs,
-- dhcp_server_msgs) stay as the sums for every reader that has them; rows
-- from before this migration have 0 in the family columns and the chart
-- treats them as no family known.
ALTER TABLE metrics ADD COLUMN dhcp4_client_msgs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics ADD COLUMN dhcp4_server_msgs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics ADD COLUMN dhcp6_client_msgs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics ADD COLUMN dhcp6_server_msgs INTEGER NOT NULL DEFAULT 0;
