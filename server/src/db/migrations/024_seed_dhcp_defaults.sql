-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '50.117.3.95,23.150.41.122,144.202.66.214,209.205.228.50', datetime('now'));
