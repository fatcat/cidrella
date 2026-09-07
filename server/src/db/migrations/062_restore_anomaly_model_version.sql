-- Migration 060 moved anomaly model ownership from client_ip to identity. Its
-- published schema retained the obsolete model_path field, while the anomaly
-- sidecar reads and increments model_version. Restore that runtime-owned field
-- and recover values saved by the migration 060 compatibility preparation.
--
-- The backup table is absent when the original v0.4.18-pre.4 migration already
-- completed against a migration-042 database. In that case existing rows start
-- at version 1, matching the sidecar's default.
CREATE TABLE IF NOT EXISTS _migration_060_anomaly_model_versions (
  client_ip TEXT PRIMARY KEY,
  model_version INTEGER NOT NULL
);

ALTER TABLE anomaly_models
  ADD COLUMN model_version INTEGER NOT NULL DEFAULT 1;

UPDATE anomaly_models
SET model_version = COALESCE(
  (
    SELECT legacy.model_version
    FROM _migration_060_anomaly_model_versions legacy
    WHERE legacy.client_ip = anomaly_models.client_ip
  ),
  model_version
);

DROP TABLE _migration_060_anomaly_model_versions;
