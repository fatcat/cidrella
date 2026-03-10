-- Add folder_id to dns_zones so zones can be grouped by folder
ALTER TABLE dns_zones ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;

-- Backfill: inherit folder_id from the linked subnet
UPDATE dns_zones SET folder_id = (
  SELECT s.folder_id FROM subnets s WHERE s.id = dns_zones.subnet_id
) WHERE subnet_id IS NOT NULL;
