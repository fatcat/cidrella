-- Fix option 51 (lease time) default to 86400 seconds (24h) to match default_lease_time setting.
-- Previous value was 3600 (1h) which conflicted with the 24h default.
UPDATE dhcp_option_defaults SET value = '3600' WHERE option_code = 51;
