-- Rename the two "whitelist" tables to "allowlist" and the anomaly column
-- with them. The lists themselves are untouched: this is a rename, not a
-- rebuild. blocklist_allowlist is the DNS exception list (domains never
-- blocked by feeds, categories or GeoIP); anomaly_allowlist is the set of
-- devices the anomaly detector skips.
ALTER TABLE blocklist_whitelist RENAME TO blocklist_allowlist;
ALTER TABLE anomaly_whitelist RENAME TO anomaly_allowlist;
ALTER TABLE anomaly_allowlist RENAME COLUMN whitelisted_at TO allowlisted_at;
DROP INDEX IF EXISTS idx_anomaly_whitelist_identity;
CREATE INDEX IF NOT EXISTS idx_anomaly_allowlist_identity ON anomaly_allowlist(identity);
