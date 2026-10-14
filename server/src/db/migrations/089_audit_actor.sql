-- Who, how and from where, for every audit row (services/audit.js writes them).
--
-- actor: the username, kept on the row so it survives the user being deleted,
-- or 'system' for what CIDRella does on its own. origin: 'ui' (a sign-in
-- session), 'api-token', 'system' or 'cli' (an update or rollback run from a
-- shell, recorded at the next boot). source: for a system row, what acted
-- ('proxy-health', 'scheduler', 'boot', ...). source_ip: the client address of
-- the request. Rows written before this migration keep origin and source_ip
-- empty.

ALTER TABLE audit_log ADD COLUMN actor TEXT;
ALTER TABLE audit_log ADD COLUMN origin TEXT;
ALTER TABLE audit_log ADD COLUMN source TEXT;
ALTER TABLE audit_log ADD COLUMN source_ip TEXT;

UPDATE audit_log
SET actor = (SELECT username FROM users WHERE users.id = audit_log.user_id)
WHERE actor IS NULL AND user_id IS NOT NULL;

-- One naming scheme, <entity>_<past verb>, for the rows written with the bare
-- verbs before it.
UPDATE audit_log SET action = entity_type || '_created'
WHERE action = 'create' AND entity_type IS NOT NULL;
UPDATE audit_log SET action = entity_type || '_updated'
WHERE action = 'update' AND entity_type IS NOT NULL;
UPDATE audit_log SET action = entity_type || '_deleted'
WHERE action = 'delete' AND entity_type IS NOT NULL;
UPDATE audit_log SET action = entity_type || '_updated'
WHERE action = 'configure' AND entity_type IS NOT NULL;
UPDATE audit_log SET action = 'subnet_name_template_applied' WHERE action = 'template_applied';
UPDATE audit_log SET action = 'backup_restored' WHERE action = 'restore';
UPDATE audit_log SET action = 'geoip_db_refreshed' WHERE action = 'geoip_db_updated';
UPDATE audit_log SET action = 'host_filtering_changed' WHERE action = 'filtering_changed';

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);

-- Retention goes from 7 days to 90. Nothing has ever offered to change it, so
-- a stored 7 is the old default rather than a choice.
UPDATE settings SET value = '90' WHERE key = 'audit_log_retention_days' AND value = '7';
