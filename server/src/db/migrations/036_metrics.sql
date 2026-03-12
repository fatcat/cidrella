-- Metrics time-series for dashboard charts
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  dns_queries INTEGER DEFAULT 0,
  dhcp_requests INTEGER DEFAULT 0,
  blocklist_blocks INTEGER DEFAULT 0,
  geoip_blocks INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

-- Blocklist category hit counts per time bucket
CREATE TABLE IF NOT EXISTS metrics_blocklist_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL,
  count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_blhits_ts ON metrics_blocklist_hits(ts);

-- GeoIP country hit counts per time bucket
CREATE TABLE IF NOT EXISTS metrics_geoip_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  country TEXT NOT NULL,
  count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_geohits_ts ON metrics_geoip_hits(ts);
