-- Add source_url column so admins can override the default blocklist URL per category
ALTER TABLE blocklist_categories ADD COLUMN source_url TEXT;
