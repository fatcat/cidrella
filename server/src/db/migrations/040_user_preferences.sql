-- Per-user preferences (JSON blob)
ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}';
