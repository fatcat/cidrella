-- IP lifecycle event history
CREATE TABLE IF NOT EXISTS ip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address_id INTEGER NOT NULL,
  subnet_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ip_address_id) REFERENCES ip_addresses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ip_events_ip ON ip_events(ip_address_id);
CREATE INDEX IF NOT EXISTS idx_ip_events_subnet_time ON ip_events(subnet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_events_type ON ip_events(event_type, created_at);
