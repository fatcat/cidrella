-- Composite index for scan_results lookup by scan_id + ip_address
CREATE INDEX IF NOT EXISTS idx_scan_results_scan_ip ON scan_results(scan_id, ip_address);
