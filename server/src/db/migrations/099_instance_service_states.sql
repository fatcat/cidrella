-- What an instance's DNS and DHCP servers are doing as it last said:
-- 'serving', 'off' (switched off, or DHCP held by another instance) or
-- 'down' (on, but the server is not running). NULL until it reports.
-- The controller's own knowledge, like last_contact_at: never synced.
ALTER TABLE sync_instances ADD COLUMN dns_state TEXT;
ALTER TABLE sync_instances ADD COLUMN dhcp_state TEXT;
