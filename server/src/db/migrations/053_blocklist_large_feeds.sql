-- Blocklist: support very large feeds.
--
-- Upstream feeds outgrew the old 20MB download cap. The Block List Project
-- malware list alone is now ~51MB / 2.65M entries, and it keeps growing. Three
-- things had to change to make that workable, two of them schema.
--
-- 1. blocklist_domains is rebuilt WITHOUT ROWID, keyed on (domain,
--    category_slug). The old table carried an AUTOINCREMENT id nobody read,
--    which meant every domain was stored twice: once in the table and once in
--    the UNIQUE index. On the malware list that measured 192MB on disk vs 90MB
--    here, and per-query lookups went from 24.3us to 8.1us because the table
--    IS the index now, so there is no rowid indirection.
--
--    Domain lookups moved out of an in-memory Map and into this table (see
--    dns-proxy.js), which is what makes the lookup cost matter. The Map had a
--    hard V8 ceiling at 16,777,216 entries and cost several hundred MB
--    resident; SQLite has neither problem.
--
-- 2. The table is recreated EMPTY rather than copied. Every row in it is
--    derived from an upstream feed, so it is a cache, and the scheduler
--    refetches ~10s after boot (blocklist.js startBlocklistScheduler). Copying
--    2.65M rows through a migration would stall startup for no benefit.
--    blocklist_whitelist is NOT touched here: that one is operator data.
--
-- 3. etag / last_modified support conditional GET, so an unchanged feed costs
--    a 304 instead of a 51MB download on every scheduled refresh.
--
-- 053 is simply the next free number after 052_normalize_dns_names.sql.

-- Conditional-GET validators. Stored per category, and they are specific to
-- the Content-Encoding we request: the same URL returns W/"..." under gzip and
-- "..." under identity. We always send Accept-Encoding: gzip, so these stay
-- consistent. A mismatch would just yield a 200 instead of a 304, never a
-- wrong answer.
ALTER TABLE blocklist_categories ADD COLUMN etag TEXT;
ALTER TABLE blocklist_categories ADD COLUMN last_modified TEXT;

-- Rebuild blocklist_domains. Drop first so the FK and both old indexes go with
-- it; foreign_keys is ON (db/init.js) and the old table had an ON DELETE
-- CASCADE reference to blocklist_categories, which the new one keeps.
DROP TABLE IF EXISTS blocklist_domains;

CREATE TABLE blocklist_domains (
  domain TEXT NOT NULL,
  category_slug TEXT NOT NULL REFERENCES blocklist_categories(slug) ON DELETE CASCADE,
  PRIMARY KEY (domain, category_slug)
) WITHOUT ROWID;

-- No secondary indexes at all, deliberately.
--
-- idx_blocklist_domains_domain is redundant: the primary key already leads
-- with domain, which is the DNS hot path, and the table IS the index now.
--
-- idx_blocklist_domains_cat is dropped rather than recreated. A secondary
-- index on a WITHOUT ROWID table has to carry the full primary key, so it
-- duplicated the entire table: measured at 90.2MB against a 90.2MB table on
-- the malware feed, 37% of the whole database file. What it bought was the
-- per-category sweep dropping from 0.09s to 0.00s, on an operation that runs
-- a few times a day. The three route queries that join on category_slug
-- (stats, and the two halves of search) are COUNT DISTINCT and unanchored
-- LIKE, so they scan the table with or without it.
--
-- If a future query makes per-category access hot, add it back knowingly and
-- budget for the table-sized cost.

-- Staging for the stage-and-sweep refresh. A refresh streams the feed in here
-- first, leaving blocklist_domains untouched, so a download that fails halfway
-- changes nothing. Only once the feed is fully staged does it insert into
-- blocklist_domains and then delete what is absent from staging. Inserts
-- before deletes means a domain present in both the old and new feed is never
-- momentarily missing, so the resolver can briefly over-block but never
-- under-block.
--
-- Emptied at the end of every refresh, but SQLite keeps the pages on the
-- freelist rather than shrinking the file, so expect a stable high-water mark
-- of roughly the largest feed (about 67MB for the malware list). That space is
-- reused by the next refresh, it does not keep growing. A TEMP table would
-- avoid it, but temp storage location is not ours to predict and a tmpfs /tmp
-- would turn this into RAM on the appliances least able to spare it.
CREATE TABLE IF NOT EXISTS blocklist_stage (
  domain TEXT PRIMARY KEY
) WITHOUT ROWID;

-- Domain counts describe the table we just emptied.
UPDATE blocklist_categories SET domain_count = 0;

-- Force a refetch on next boot regardless of schedule: the validators would
-- otherwise claim a 304 for content we no longer have.
UPDATE blocklist_categories SET last_fetched_at = NULL, etag = NULL, last_modified = NULL;
