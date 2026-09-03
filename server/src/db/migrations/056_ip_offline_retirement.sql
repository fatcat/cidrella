-- Persist the start of one continuous offline interval. This is separate from
-- last_seen_at: the last observation can precede the scan/passive decision
-- that moved the address offline.
ALTER TABLE ip_addresses ADD COLUMN offline_since_at TEXT;

-- Existing offline learned rows get a fresh window on upgrade. This avoids
-- deleting anything immediately based on a legacy last_seen timestamp whose
-- relationship to the actual offline edge is unknowable.
UPDATE ip_addresses
SET offline_since_at = datetime('now')
WHERE is_online = 0
  AND (
    allocation_state IN ('dynamic_dhcp', 'slaac')
    OR is_rogue = 1
    OR status = 'dhcp'
    OR detection_source IN ('dhcp_lease', 'slaac', 'scanner', 'passive', 'neighbor_discovery')
  );

CREATE INDEX IF NOT EXISTS idx_ip_addresses_offline_retirement
  ON ip_addresses(is_online, offline_since_at, allocation_state);
