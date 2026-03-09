-- 2-tier liveness scan opt-in: Subnet → Host
-- NULL = inherit from global default_scan_enabled setting; 0 = disabled; 1 = enabled

ALTER TABLE subnets ADD COLUMN scan_enabled INTEGER DEFAULT NULL;
ALTER TABLE ip_addresses ADD COLUMN scan_enabled INTEGER DEFAULT NULL;
