-- Seed enabled_by_default for standard DHCP options
-- Ensures these options are auto-selected when creating new scopes

-- Ensure rows exist for the seven standard options (mask, router, DNS, domain,
-- NTP, lease time, domain search). NTP (42) was added 2026-04-19; pre-existing
-- installs are unaffected — this migration only runs on fresh schema_version.
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (1, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (3, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (6, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (15, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (42, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (51, 1);
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, enabled_by_default) VALUES (119, 1);

-- Set enabled_by_default for rows that already existed
UPDATE dhcp_option_defaults SET enabled_by_default = 1 WHERE option_code IN (1, 3, 6, 15, 42, 51, 119);
