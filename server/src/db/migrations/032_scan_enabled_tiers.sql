-- 3-tier liveness scan opt-in: Organization → Subnet → Host
-- NULL = inherit from parent; 0 = disabled; 1 = enabled

ALTER TABLE folders ADD COLUMN scan_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subnets ADD COLUMN scan_enabled INTEGER DEFAULT NULL;
ALTER TABLE ip_addresses ADD COLUMN scan_enabled INTEGER DEFAULT NULL;
