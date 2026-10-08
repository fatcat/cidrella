-- anomaly_scores: drop the UNIQUE(client_ip, window_start) an early anomaly
-- sidecar put on the table (ANOM-01). Installs where the sidecar created the
-- table before migration 042 ran kept it, since 042 is CREATE TABLE IF NOT
-- EXISTS, and migration 060 added UNIQUE(identity, window_start) beside it.
-- Scores have been keyed by device since 060: a client on a short lease is
-- scored under its MAC while leased and under its IP once the lease lapses,
-- and when both land in one window the old constraint rejected the second
-- save, losing that window's score.
--
-- Rebuilt on every install, so all of them end with one shape. SQLite cannot
-- drop a table constraint in place. Ids are copied and the id sequence carried
-- over, so a new score never reuses the id of one already pruned: the anomaly
-- counter's acknowledgement stores a row id, and a reused id below it would
-- hide a new anomaly. No table references anomaly_scores, so this needs no
-- foreign-key handling.
CREATE TABLE anomaly_scores_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ip TEXT NOT NULL,
  identity TEXT,
  scored_at TEXT NOT NULL DEFAULT (datetime('now')),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  anomaly_score REAL NOT NULL,
  is_anomaly INTEGER NOT NULL DEFAULT 0,
  severity TEXT,
  top_features TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  threat_score REAL
);

INSERT INTO anomaly_scores_new
  (id, client_ip, identity, scored_at, window_start, window_end, anomaly_score, is_anomaly,
   severity, top_features, resolved, resolved_at, threat_score)
SELECT id, client_ip, identity, scored_at, window_start, window_end, anomaly_score, is_anomaly,
  severity, top_features, resolved, resolved_at, threat_score
FROM anomaly_scores;

-- The copy set the new table's sequence to its highest id; the old one can be
-- higher, past rows the score retention pruned.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'anomaly_scores_new', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'anomaly_scores_new');
UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'anomaly_scores'), 0))
WHERE name = 'anomaly_scores_new';

DROP TABLE anomaly_scores;
ALTER TABLE anomaly_scores_new RENAME TO anomaly_scores;

CREATE UNIQUE INDEX idx_anomaly_scores_identity_window
  ON anomaly_scores(identity, window_start);
CREATE INDEX idx_anomaly_scores_active
  ON anomaly_scores(is_anomaly, resolved) WHERE is_anomaly = 1 AND resolved = 0;
CREATE INDEX idx_anomaly_scores_client
  ON anomaly_scores(client_ip, window_start);
