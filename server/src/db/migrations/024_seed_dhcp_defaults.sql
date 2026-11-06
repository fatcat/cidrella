-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '216.229.4.69,162.244.81.139,40.160.28.79,198.137.202.32', datetime('now'));
