-- Proxy performance metrics (one row per 60-second aggregation cycle)
CREATE TABLE IF NOT EXISTS metrics_proxy_perf (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  query_count INTEGER DEFAULT 0,
  latency_min INTEGER,         -- microseconds
  latency_avg INTEGER,         -- microseconds
  latency_max INTEGER,         -- microseconds
  latency_p95 INTEGER,         -- microseconds
  cache_hits INTEGER DEFAULT 0,
  cache_misses INTEGER DEFAULT 0,
  timeouts INTEGER DEFAULT 0,
  pending_queries INTEGER DEFAULT 0,
  cpu_percent REAL DEFAULT 0,  -- whole process CPU %
  rss_mb REAL DEFAULT 0,
  heap_mb REAL DEFAULT 0,
  startup_ms INTEGER           -- NULL except first row after proxy start
);
CREATE INDEX IF NOT EXISTS idx_proxy_perf_ts ON metrics_proxy_perf(ts);
