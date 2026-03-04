-- Add PTR record type support by recreating dns_records with updated CHECK constraint

CREATE TABLE dns_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('A', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR')),
  value TEXT NOT NULL,
  priority INTEGER,
  weight INTEGER,
  port INTEGER,
  ttl INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id) REFERENCES dns_zones(id) ON DELETE CASCADE
);

INSERT INTO dns_records_new SELECT id, zone_id, name, type, value, priority, weight, port, ttl, enabled, created_at, updated_at FROM dns_records;

DROP TABLE dns_records;
ALTER TABLE dns_records_new RENAME TO dns_records;

CREATE INDEX IF NOT EXISTS idx_dns_records_zone ON dns_records(zone_id);
CREATE INDEX IF NOT EXISTS idx_dns_records_type ON dns_records(type);
