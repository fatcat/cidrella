-- Add SOA fields to dns_zones
ALTER TABLE dns_zones ADD COLUMN soa_primary_ns TEXT DEFAULT 'ns1.localhost';
ALTER TABLE dns_zones ADD COLUMN soa_admin_email TEXT DEFAULT 'admin.localhost';
ALTER TABLE dns_zones ADD COLUMN soa_serial INTEGER DEFAULT 1;
ALTER TABLE dns_zones ADD COLUMN soa_refresh INTEGER DEFAULT 3600;
ALTER TABLE dns_zones ADD COLUMN soa_retry INTEGER DEFAULT 900;
ALTER TABLE dns_zones ADD COLUMN soa_expire INTEGER DEFAULT 604800;
ALTER TABLE dns_zones ADD COLUMN soa_minimum_ttl INTEGER DEFAULT 86400;

-- Add TTL to dns_records
ALTER TABLE dns_records ADD COLUMN ttl INTEGER;
