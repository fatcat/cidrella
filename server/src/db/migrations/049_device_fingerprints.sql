-- Passive device/OS fingerprints, keyed by MAC (a fingerprint is a property of
-- the device, reused across whatever IPs it holds). Populated from dnsmasq
-- log-dhcp (DHCP option 55 / 60 / hostname) + MAC OUI, classified offline.
CREATE TABLE IF NOT EXISTS device_fingerprints (
  mac_address      TEXT PRIMARY KEY,
  dhcp_fingerprint TEXT,    -- option 55 param-request-list as csv "1,3,6,15,..."
  vendor_class     TEXT,    -- option 60 vendor class identifier
  dhcp_hostname    TEXT,    -- option 12 / supplied hostname
  device_type      TEXT,    -- Computer / Smartphone / Printer / IoT / Router / ...
  os_family        TEXT,    -- Windows / macOS / Apple iOS / Android / Linux / ...
  confidence       INTEGER NOT NULL DEFAULT 0,  -- 0-100
  source           TEXT NOT NULL DEFAULT 'dhcp', -- 'dhcp' | 'manual'
  raw              TEXT,
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
