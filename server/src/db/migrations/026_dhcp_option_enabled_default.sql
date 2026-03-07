-- Track which DHCP options are enabled by default when creating new scopes
ALTER TABLE dhcp_option_defaults ADD COLUMN enabled_by_default INTEGER NOT NULL DEFAULT 0;

-- Recreate table to allow NULL values (enabled-only entries with no default value)
CREATE TABLE dhcp_option_defaults_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_code INTEGER NOT NULL UNIQUE,
  value TEXT,
  enabled_by_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO dhcp_option_defaults_new (id, option_code, value, enabled_by_default, updated_at)
  SELECT id, option_code, value, enabled_by_default, updated_at FROM dhcp_option_defaults;
DROP TABLE dhcp_option_defaults;
ALTER TABLE dhcp_option_defaults_new RENAME TO dhcp_option_defaults;
