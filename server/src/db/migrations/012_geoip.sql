-- Phase 8: GeoIP DNS filtering

CREATE TABLE IF NOT EXISTS geoip_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL UNIQUE,
  country_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_geoip_rules_code ON geoip_rules(country_code);
CREATE INDEX IF NOT EXISTS idx_geoip_rules_enabled ON geoip_rules(enabled);
