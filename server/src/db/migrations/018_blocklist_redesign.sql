-- Blocklist redesign: replace custom sources with Block List Project categories

-- New category-based blocklist table
CREATE TABLE IF NOT EXISTS blocklist_categories (
  slug TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  domain_count INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT,
  last_error TEXT
);

-- Blocklist domains keyed by category slug
CREATE TABLE IF NOT EXISTS blocklist_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  category_slug TEXT NOT NULL REFERENCES blocklist_categories(slug) ON DELETE CASCADE,
  UNIQUE(domain, category_slug)
);
CREATE INDEX IF NOT EXISTS idx_blocklist_domains_domain ON blocklist_domains(domain);
CREATE INDEX IF NOT EXISTS idx_blocklist_domains_cat ON blocklist_domains(category_slug);

-- Drop old source-based tables
DROP TABLE IF EXISTS blocklist_entries;
DROP TABLE IF EXISTS blocklist_sources;
