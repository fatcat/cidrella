-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '157.245.125.229,45.79.214.107,137.190.2.4,23.157.160.168', datetime('now'));
