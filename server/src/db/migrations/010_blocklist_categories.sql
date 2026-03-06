-- Blocklist categories for group enable/disable
ALTER TABLE blocklist_sources ADD COLUMN category TEXT NOT NULL DEFAULT 'other'
  CHECK(category IN ('ads','malware','tracking','adult','other'));

-- Update preconfigured sources with categories
UPDATE blocklist_sources SET category = 'malware' WHERE url LIKE '%StevenBlack%';
UPDATE blocklist_sources SET category = 'ads' WHERE url LIKE '%oisd.nl%';
UPDATE blocklist_sources SET category = 'ads' WHERE url LIKE '%pgl.yoyo.org%';
