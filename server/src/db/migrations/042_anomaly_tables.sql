-- Ensure anomaly tables exist so routes don't need 'no such table' guards
CREATE TABLE IF NOT EXISTS anomaly_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ip TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  anomaly_score REAL NOT NULL,
  is_anomaly INTEGER NOT NULL DEFAULT 0,
  severity TEXT,
  top_features TEXT,
  scored_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS anomaly_models (
  client_ip TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'learning',
  training_rows INTEGER NOT NULL DEFAULT 0,
  trained_at TEXT,
  model_path TEXT
);
