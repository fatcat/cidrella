ALTER TABLE dhcp_scope_pools ADD COLUMN topology_origin TEXT NOT NULL DEFAULT 'configured'
  CHECK(topology_origin IN ('configured', 'projected', 'split_default'));
ALTER TABLE dhcp_scope_pools ADD COLUMN source_scope_id INTEGER;
ALTER TABLE dhcp_scope_pools ADD COLUMN source_start_ip TEXT;
ALTER TABLE dhcp_scope_pools ADD COLUMN source_end_ip TEXT;
