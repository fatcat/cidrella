-- Phase 2b: Hierarchical subnet tree

-- Add hierarchy columns
ALTER TABLE subnets ADD COLUMN parent_id INTEGER REFERENCES subnets(id) ON DELETE CASCADE;
ALTER TABLE subnets ADD COLUMN status TEXT NOT NULL DEFAULT 'allocated' CHECK(status IN ('unallocated', 'allocated'));
ALTER TABLE subnets ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subnets ADD COLUMN has_reverse_dns INTEGER NOT NULL DEFAULT 0;

-- Indexes for tree queries
CREATE INDEX IF NOT EXISTS idx_subnets_parent ON subnets(parent_id);
CREATE INDEX IF NOT EXISTS idx_subnets_status ON subnets(status);
