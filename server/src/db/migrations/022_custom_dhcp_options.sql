-- Custom user-defined DHCP options (vendor-specific, codes 128-254)
CREATE TABLE IF NOT EXISTS dhcp_custom_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
