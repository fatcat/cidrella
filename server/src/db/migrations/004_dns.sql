-- Phase 3: DNS zones and records

CREATE TABLE IF NOT EXISTS dns_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('forward', 'reverse')),
  subnet_id INTEGER,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS dns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('A', 'CNAME', 'MX', 'TXT', 'SRV')),
  value TEXT NOT NULL,
  priority INTEGER,
  weight INTEGER,
  port INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id) REFERENCES dns_zones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dns_records_zone ON dns_records(zone_id);
CREATE INDEX IF NOT EXISTS idx_dns_records_type ON dns_records(type);
CREATE INDEX IF NOT EXISTS idx_dns_zones_subnet ON dns_zones(subnet_id);
