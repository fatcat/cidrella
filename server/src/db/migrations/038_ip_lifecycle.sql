-- IP lifecycle columns: move rogue state and lifecycle tracking onto ip_addresses
ALTER TABLE ip_addresses ADD COLUMN first_seen_at TEXT;
ALTER TABLE ip_addresses ADD COLUMN last_scanned_at TEXT;
ALTER TABLE ip_addresses ADD COLUMN is_rogue INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ip_addresses ADD COLUMN rogue_reason TEXT;
ALTER TABLE ip_addresses ADD COLUMN detection_source TEXT;

-- Backfill first_seen_at from created_at for rows with activity
UPDATE ip_addresses SET first_seen_at = created_at
  WHERE is_online = 1 OR last_seen_at IS NOT NULL OR mac_address IS NOT NULL;

-- Backfill is_rogue from latest completed scan per subnet
UPDATE ip_addresses SET
  is_rogue = 1,
  rogue_reason = (
    SELECT sr.conflict_reason FROM scan_results sr
    JOIN network_scans ns ON sr.scan_id = ns.id
    WHERE ns.subnet_id = ip_addresses.subnet_id
      AND sr.ip_address = ip_addresses.ip_address
      AND sr.is_conflict = 1 AND ns.status = 'completed'
    ORDER BY ns.completed_at DESC LIMIT 1
  )
WHERE EXISTS (
  SELECT 1 FROM scan_results sr
  JOIN network_scans ns ON sr.scan_id = ns.id
  WHERE ns.subnet_id = ip_addresses.subnet_id
    AND sr.ip_address = ip_addresses.ip_address
    AND sr.is_conflict = 1 AND ns.status = 'completed'
);

-- Partial index for rogue lookups
CREATE INDEX IF NOT EXISTS idx_ip_addresses_rogue ON ip_addresses(subnet_id) WHERE is_rogue = 1;

-- Prune old scan_results: keep only latest completed scan per subnet
DELETE FROM scan_results WHERE scan_id IN (
  SELECT ns.id FROM network_scans ns
  WHERE ns.status = 'completed' AND ns.id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY subnet_id ORDER BY completed_at DESC) AS rn
      FROM network_scans WHERE status = 'completed'
    ) WHERE rn = 1
  )
);
