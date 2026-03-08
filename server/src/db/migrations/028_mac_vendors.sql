CREATE TABLE IF NOT EXISTS mac_vendors (
  prefix TEXT PRIMARY KEY,       -- e.g. '00:00:0C', '00:1B:C5:00:00/36'
  prefix_length INTEGER NOT NULL DEFAULT 24,  -- 24, 28, or 36 bits
  short_name TEXT,
  vendor_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mac_vendors_prefix_length ON mac_vendors(prefix_length);
