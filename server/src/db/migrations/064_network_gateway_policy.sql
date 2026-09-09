-- Persist gateway intent independently from the currently resolved address.
-- Existing rows can only be inferred from their literal gateway, so retain
-- custom addresses explicitly and mark a missing gateway as intentional none.
ALTER TABLE subnets ADD COLUMN gateway_policy TEXT NOT NULL DEFAULT 'none'
  CHECK(gateway_policy IN ('first', 'last', 'custom', 'none'));
ALTER TABLE subnets ADD COLUMN topology_revision INTEGER NOT NULL DEFAULT 1;

UPDATE subnets
SET gateway_policy = CASE
  WHEN gateway_address IS NULL THEN 'none'
  WHEN gateway_address = network_address THEN 'custom'
  WHEN gateway_address = broadcast_address THEN 'custom'
  ELSE 'custom'
END;

-- SQLite has no built-in IPv4 arithmetic. Endpoint inference is completed by
-- the startup migration reconciler where CIDR parsing is shared with runtime.
