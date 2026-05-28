-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '162.254.225.151,193.29.63.226,172.104.209.204,198.137.202.32', datetime('now'));
