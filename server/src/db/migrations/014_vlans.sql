CREATE TABLE IF NOT EXISTS vlans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  vlan_id INTEGER NOT NULL CHECK(vlan_id >= 1 AND vlan_id <= 4094),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(folder_id, vlan_id)
);
