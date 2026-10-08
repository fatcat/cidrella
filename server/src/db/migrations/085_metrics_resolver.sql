-- Failed answers by cause each minute (utils/dns-ede.js failureCause), and
-- NXDOMAINs, beside the proxy's other minute figures.
ALTER TABLE metrics_proxy_perf ADD COLUMN servfail_dnssec INTEGER DEFAULT 0;
ALTER TABLE metrics_proxy_perf ADD COLUMN servfail_upstream INTEGER DEFAULT 0;
ALTER TABLE metrics_proxy_perf ADD COLUMN servfail_timeout INTEGER DEFAULT 0;
ALTER TABLE metrics_proxy_perf ADD COLUMN servfail_refused INTEGER DEFAULT 0;
ALTER TABLE metrics_proxy_perf ADD COLUMN servfail_other INTEGER DEFAULT 0;
ALTER TABLE metrics_proxy_perf ADD COLUMN nxdomain INTEGER DEFAULT 0;

-- What each encrypted-forwarding upstream address did each minute: one row
-- per provider address that saw traffic.
CREATE TABLE IF NOT EXISTS metrics_forwarder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,          -- the upstream's hostname
  address TEXT NOT NULL,
  protocol TEXT NOT NULL,          -- 'dot' or 'doh'
  queries INTEGER DEFAULT 0,       -- queries this provider was asked
  answers INTEGER DEFAULT 0,
  timeouts INTEGER DEFAULT 0,
  drops INTEGER DEFAULT 0,         -- a connection dropped with the query in flight, resent
  connect_failures INTEGER DEFAULT 0,
  failovers INTEGER DEFAULT 0,     -- no answer here, so the next provider was asked
  latency_p50_us INTEGER,
  latency_p95_us INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_forwarder_ts ON metrics_forwarder(ts);
