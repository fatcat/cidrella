-- A member's metrics row is stored once. The controller's mark of how far it
-- has stored is per epoch, and a member that was restored or rolled back
-- sends the rows past its restored cursor again under a new epoch; nothing
-- stopped them being stored twice. A member's row is now one per instance,
-- minute and key, and the store skips one it already holds (INSERT OR IGNORE
-- in sync/collected-streams.js).
--
-- The controller's own rows (instance_id NULL) are outside these indexes and
-- keep what they had: a restart inside one minute can still leave two.
--
-- Duplicates already stored go first, keeping the row stored first, or the
-- index could not be made. These replace migration 098's indexes on the same
-- leading columns.

DELETE FROM metrics WHERE instance_id IS NOT NULL AND id NOT IN (
  SELECT min(id) FROM metrics WHERE instance_id IS NOT NULL GROUP BY instance_id, ts
);
DELETE FROM metrics_blocklist_hits WHERE instance_id IS NOT NULL AND id NOT IN (
  SELECT min(id) FROM metrics_blocklist_hits WHERE instance_id IS NOT NULL
  GROUP BY instance_id, ts, category
);
DELETE FROM metrics_geoip_hits WHERE instance_id IS NOT NULL AND id NOT IN (
  SELECT min(id) FROM metrics_geoip_hits WHERE instance_id IS NOT NULL
  GROUP BY instance_id, ts, country
);
DELETE FROM metrics_proxy_perf WHERE instance_id IS NOT NULL AND id NOT IN (
  SELECT min(id) FROM metrics_proxy_perf WHERE instance_id IS NOT NULL GROUP BY instance_id, ts
);
DELETE FROM metrics_forwarder WHERE instance_id IS NOT NULL AND id NOT IN (
  SELECT min(id) FROM metrics_forwarder WHERE instance_id IS NOT NULL
  GROUP BY instance_id, ts, provider, address, protocol
);

DROP INDEX IF EXISTS idx_metrics_instance;
DROP INDEX IF EXISTS idx_blhits_instance;
DROP INDEX IF EXISTS idx_geohits_instance;
DROP INDEX IF EXISTS idx_proxy_perf_instance;
DROP INDEX IF EXISTS idx_metrics_forwarder_instance;

CREATE UNIQUE INDEX idx_metrics_instance ON metrics(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE UNIQUE INDEX idx_blhits_instance ON metrics_blocklist_hits(instance_id, ts, category)
  WHERE instance_id IS NOT NULL;
CREATE UNIQUE INDEX idx_geohits_instance ON metrics_geoip_hits(instance_id, ts, country)
  WHERE instance_id IS NOT NULL;
CREATE UNIQUE INDEX idx_proxy_perf_instance ON metrics_proxy_perf(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE UNIQUE INDEX idx_metrics_forwarder_instance
  ON metrics_forwarder(instance_id, ts, provider, address, protocol)
  WHERE instance_id IS NOT NULL;
