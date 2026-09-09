-- A DHCP scope owns policy and one or more configured pool intervals. Ranges
-- remain a compatibility/display projection while callers migrate to pools.
CREATE TABLE dhcp_scope_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  range_id INTEGER NOT NULL UNIQUE REFERENCES ranges(id) ON DELETE CASCADE,
  start_ip TEXT NOT NULL,
  end_ip TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_id, start_ip, end_ip)
);

CREATE INDEX idx_dhcp_scope_pools_scope ON dhcp_scope_pools(scope_id, sort_order, id);

INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
SELECT scope.id, range.id, range.start_ip, range.end_ip
FROM dhcp_scopes scope JOIN ranges range ON range.id = scope.range_id;

-- Compatibility backstop. Canonical writers update dhcp_scope_pools. These
-- triggers keep legacy range-based entry points and the range projection in
-- lockstep during the transition.
CREATE TRIGGER dhcp_scope_pool_to_range_update
AFTER UPDATE OF start_ip, end_ip ON dhcp_scope_pools
BEGIN
  UPDATE ranges SET start_ip = NEW.start_ip, end_ip = NEW.end_ip,
    updated_at = datetime('now') WHERE id = NEW.range_id;
END;

CREATE TRIGGER dhcp_range_to_scope_pool_update
AFTER UPDATE OF start_ip, end_ip ON ranges
WHEN EXISTS (SELECT 1 FROM dhcp_scope_pools WHERE range_id = NEW.id)
BEGIN
  UPDATE dhcp_scope_pools SET start_ip = NEW.start_ip, end_ip = NEW.end_ip,
    updated_at = datetime('now') WHERE range_id = NEW.id;
END;
