-- Phase 6: Domain blocklist filtering

CREATE TABLE IF NOT EXISTS blocklist_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT 'auto' CHECK(format IN ('auto','hosts','domains','adblock')),
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_update INTEGER NOT NULL DEFAULT 1,
  update_interval_hours INTEGER NOT NULL DEFAULT 24,
  last_fetched_at TEXT,
  last_entry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocklist_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES blocklist_sources(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocklist_entries_domain_source
  ON blocklist_entries(domain, source_id);
CREATE INDEX IF NOT EXISTS idx_blocklist_entries_domain
  ON blocklist_entries(domain);

CREATE TABLE IF NOT EXISTS blocklist_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preconfigured blocklist sources (fetched on first startup)
INSERT OR IGNORE INTO blocklist_sources (name, url, format) VALUES
  ('Steven Black Unified', 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', 'hosts'),
  ('OISD Small', 'https://small.oisd.nl/', 'domains'),
  ('Pete Lowe''s Ad Servers', 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0', 'hosts');
