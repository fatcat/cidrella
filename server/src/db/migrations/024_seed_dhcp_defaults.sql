-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '69.164.213.136,172.234.25.10,172.233.189.68,198.44.55.245', datetime('now'));
