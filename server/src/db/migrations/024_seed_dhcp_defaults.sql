-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '155.248.196.28,23.186.168.129,23.186.168.128,216.229.4.66', datetime('now'));
