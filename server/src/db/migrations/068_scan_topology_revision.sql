-- A scan result belongs to the exact operating-network topology that started
-- it. Parent containers survive division, so subnet_id alone cannot prevent a
-- delayed scan from recreating stale ownership after a transformation.
ALTER TABLE network_scans ADD COLUMN topology_revision INTEGER NOT NULL DEFAULT 0;

UPDATE network_scans
SET topology_revision = COALESCE(
  (SELECT topology_revision FROM subnets WHERE subnets.id = network_scans.subnet_id),
  0
);
