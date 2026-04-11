-- Anomaly detection client whitelist
CREATE TABLE IF NOT EXISTS anomaly_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ip TEXT NOT NULL UNIQUE,
  reason TEXT,
  whitelisted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_anomaly_whitelist_ip ON anomaly_whitelist(client_ip);
