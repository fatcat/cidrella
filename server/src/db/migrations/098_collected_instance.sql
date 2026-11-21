-- Analytics from every instance (docs/REDUNDANCY-PLAN.md, section 4). A row a
-- box measured itself has no instance_id; a row a member sent up carries that
-- member's instance id. So nothing already stored changes, a single box never
-- writes the column, and the indexes below stay empty on it.
ALTER TABLE metrics ADD COLUMN instance_id TEXT;
ALTER TABLE metrics_blocklist_hits ADD COLUMN instance_id TEXT;
ALTER TABLE metrics_geoip_hits ADD COLUMN instance_id TEXT;
ALTER TABLE metrics_proxy_perf ADD COLUMN instance_id TEXT;
ALTER TABLE metrics_forwarder ADD COLUMN instance_id TEXT;

-- Members' rows alone: one instance's rows over a range, and whether a table
-- holds any at all.
CREATE INDEX idx_metrics_instance ON metrics(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE INDEX idx_blhits_instance ON metrics_blocklist_hits(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE INDEX idx_geohits_instance ON metrics_geoip_hits(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE INDEX idx_proxy_perf_instance ON metrics_proxy_perf(instance_id, ts)
  WHERE instance_id IS NOT NULL;
CREATE INDEX idx_metrics_forwarder_instance ON metrics_forwarder(instance_id, ts)
  WHERE instance_id IS NOT NULL;

-- On the controller: how far into each member's rows it has stored, so a
-- batch that arrives twice is stored once. `position` is the member's own row
-- id; `epoch` changes when the member's ids start over, and the position with
-- it. The mark for DNS queries is kept in the analytics database, beside the
-- rows it counts.
CREATE TABLE sync_collected_marks (
  instance_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  epoch TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (instance_id, stream)
);
