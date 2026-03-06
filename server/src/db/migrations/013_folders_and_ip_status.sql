-- Subnet UI redesign: folders, scan scheduling, IP online tracking

-- Folders table for organizing subnets
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add folder_id to subnets (root subnets belong to a folder)
ALTER TABLE subnets ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;

-- Scan scheduling per subnet
ALTER TABLE subnets ADD COLUMN scan_interval TEXT DEFAULT NULL;

-- Online status tracking on ip_addresses
ALTER TABLE ip_addresses ADD COLUMN last_seen_at TEXT;
ALTER TABLE ip_addresses ADD COLUMN last_seen_mac TEXT;
ALTER TABLE ip_addresses ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_subnets_folder ON subnets(folder_id);

-- Migrate existing root subnets into a Default folder
INSERT INTO folders (name, description, sort_order) VALUES ('Default', 'Default folder', 0);
UPDATE subnets SET folder_id = (SELECT id FROM folders WHERE name = 'Default') WHERE parent_id IS NULL;
