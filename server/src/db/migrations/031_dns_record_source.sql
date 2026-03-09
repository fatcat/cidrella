-- Add source column to dns_records to distinguish manual vs DHCP-created records
ALTER TABLE dns_records ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_dns_records_source ON dns_records(source);
