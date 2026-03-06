-- Global default values for DHCP options
CREATE TABLE IF NOT EXISTS dhcp_option_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_code INTEGER NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Per-scope option overrides
CREATE TABLE IF NOT EXISTS dhcp_scope_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  option_code INTEGER NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(scope_id, option_code)
);
CREATE INDEX IF NOT EXISTS idx_scope_options_scope ON dhcp_scope_options(scope_id);
