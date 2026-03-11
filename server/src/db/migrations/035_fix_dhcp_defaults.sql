-- Ensure option 51 (lease time) default is 3600 seconds (1h) to match default_lease_time setting.
UPDATE dhcp_option_defaults SET value = '3600' WHERE option_code = 51;
