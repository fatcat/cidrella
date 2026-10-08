-- Split the per-minute DHCP counter so the dashboard can draw requests
-- against responses. dhcp_requests stays as the sum of both, so every
-- reader of the old column keeps working; rows from before this migration
-- have 0 in the new columns and the chart treats them as no split known.
ALTER TABLE metrics ADD COLUMN dhcp_client_msgs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics ADD COLUMN dhcp_server_msgs INTEGER NOT NULL DEFAULT 0;
