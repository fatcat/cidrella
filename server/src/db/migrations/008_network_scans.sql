-- Phase 5: Network scanning and conflict detection

CREATE TABLE IF NOT EXISTS network_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  total_ips INTEGER NOT NULL DEFAULT 0,
  scanned_ips INTEGER NOT NULL DEFAULT 0,
  conflicts_found INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scan_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  mac_address TEXT,
  responded INTEGER NOT NULL DEFAULT 0,
  is_conflict INTEGER NOT NULL DEFAULT 0,
  conflict_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (scan_id) REFERENCES network_scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_results_scan ON scan_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_network_scans_subnet ON network_scans(subnet_id);
