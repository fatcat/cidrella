-- Anomaly detection identity: key scores/models/whitelist by MAC address
-- instead of raw client IP wherever a MAC is known (via the current DHCP
-- lease), falling back to the IP itself for statically-configured hosts
-- CIDRella has no lease for. This stops a device that takes over an IP
-- from inheriting the previous holder's learned baseline.
--
-- Historical lease-to-IP mapping isn't tracked (dhcp_leases only holds the
-- current lease), so backfilling old rows against the CURRENT lease table
-- is a best-effort approximation, not historically exact. New rows get an
-- accurate identity going forward from the scoring daemon.

ALTER TABLE anomaly_scores ADD COLUMN identity TEXT;
UPDATE anomaly_scores
SET identity = COALESCE(
  (SELECT mac_address FROM dhcp_leases WHERE ip_address = anomaly_scores.client_ip LIMIT 1),
  client_ip
);

-- A stray pre-migration duplicate (identity, window_start) pair (only
-- possible if dhcp_leases currently maps two legacy client_ips onto the
-- same MAC) would break the unique index below; keep the newer row.
DELETE FROM anomaly_scores
WHERE id NOT IN (
  SELECT MAX(id) FROM anomaly_scores GROUP BY identity, window_start
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anomaly_scores_identity_window
  ON anomaly_scores(identity, window_start);

-- anomaly_models: primary key moves from client_ip to identity. SQLite
-- can't alter a primary key in place, so rebuild the table. client_ip is
-- kept as an informational "last known IP" column.
CREATE TABLE anomaly_models_new (
  identity TEXT PRIMARY KEY,
  client_ip TEXT,
  status TEXT NOT NULL DEFAULT 'learning',
  training_rows INTEGER NOT NULL DEFAULT 0,
  trained_at TEXT,
  model_path TEXT
);

INSERT INTO anomaly_models_new (identity, client_ip, status, training_rows, trained_at, model_path)
WITH resolved AS (
  SELECT
    COALESCE((SELECT mac_address FROM dhcp_leases WHERE ip_address = m.client_ip LIMIT 1), m.client_ip) AS identity,
    m.client_ip, m.status, m.training_rows, m.trained_at, m.model_path
  FROM anomaly_models m
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY trained_at DESC) AS rn
  FROM resolved
)
SELECT identity, client_ip, status, training_rows, trained_at, model_path FROM ranked WHERE rn = 1;

DROP TABLE anomaly_models;
ALTER TABLE anomaly_models_new RENAME TO anomaly_models;

-- anomaly_whitelist: same rebuild, unique on identity instead of client_ip.
CREATE TABLE anomaly_whitelist_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  client_ip TEXT NOT NULL,
  reason TEXT,
  whitelisted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO anomaly_whitelist_new (id, identity, client_ip, reason, whitelisted_at)
WITH resolved AS (
  SELECT
    w.id,
    COALESCE((SELECT mac_address FROM dhcp_leases WHERE ip_address = w.client_ip LIMIT 1), w.client_ip) AS identity,
    w.client_ip, w.reason, w.whitelisted_at
  FROM anomaly_whitelist w
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY whitelisted_at DESC) AS rn
  FROM resolved
)
SELECT id, identity, client_ip, reason, whitelisted_at FROM ranked WHERE rn = 1;

DROP TABLE anomaly_whitelist;
ALTER TABLE anomaly_whitelist_new RENAME TO anomaly_whitelist;
CREATE INDEX IF NOT EXISTS idx_anomaly_whitelist_identity ON anomaly_whitelist(identity);
