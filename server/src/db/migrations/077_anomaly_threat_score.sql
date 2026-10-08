-- Threat shape per scored window: a 0..1 rule score over entropy, name
-- length, subdomain depth, NXDOMAIN rate and block rate, written by the
-- anomaly sidecar (server/anomaly/threat.py) for every window it scores.
-- Independent of the model score, so the triage map can plot "unusual for
-- this device" against "shaped like an attack". Rows scored before this
-- release stay NULL: the feature values behind them were never kept, so
-- there is nothing to backfill from. The sidecar fills new rows on its
-- next cycle.
ALTER TABLE anomaly_scores ADD COLUMN threat_score REAL;
