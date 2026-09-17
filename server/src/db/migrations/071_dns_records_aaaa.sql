-- AAAA records. The type CHECK is part of the table definition, so the table
-- is rebuilt (the same procedure migration 006 used to add PTR).
--
-- Runs under the foreign-keys-off procedure in runMigrations. Nothing
-- references dns_records, but the runner treats every rebuild the same way.

CREATE TABLE dns_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR')),
  value TEXT NOT NULL,
  priority INTEGER,
  weight INTEGER,
  port INTEGER,
  ttl INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'manual',
  FOREIGN KEY (zone_id) REFERENCES dns_zones(id) ON DELETE CASCADE
);

INSERT INTO dns_records_new (
  id, zone_id, name, type, value, priority, weight, port, ttl, enabled,
  created_at, updated_at, source
)
SELECT
  id, zone_id, name, type, value, priority, weight, port, ttl, enabled,
  created_at, updated_at, source
FROM dns_records;

DROP TABLE dns_records;
ALTER TABLE dns_records_new RENAME TO dns_records;

CREATE INDEX idx_dns_records_zone ON dns_records(zone_id);
CREATE INDEX idx_dns_records_type ON dns_records(type);
CREATE INDEX idx_dns_records_source ON dns_records(source);
