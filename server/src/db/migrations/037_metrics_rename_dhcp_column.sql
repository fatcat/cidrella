-- Fix metrics table: ensure column is dhcp_requests (not dhcp_leases from early 036)
-- Recreate table to handle both cases cleanly. Metrics data is recent so loss is minimal.
DROP TABLE IF EXISTS metrics;
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  dns_queries INTEGER DEFAULT 0,
  dhcp_requests INTEGER DEFAULT 0,
  blocklist_blocks INTEGER DEFAULT 0,
  geoip_blocks INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);
