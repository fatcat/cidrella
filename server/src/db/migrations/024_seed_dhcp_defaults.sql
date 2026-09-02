-- Seed sensible DHCP option defaults
INSERT OR IGNORE INTO dhcp_option_defaults (option_code, value, updated_at)
VALUES
  (51, '3600', datetime('now')),
  (42, '162.244.81.139,23.155.72.147,66.85.78.80,66.118.229.14', datetime('now'));
