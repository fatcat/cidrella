-- Rename ip_addresses status 'reserved' → 'locked' to avoid confusion with DHCP reservations.
-- SQLite doesn't support ALTER CHECK constraints, so we update the data and rely on
-- application-level validation (the CHECK constraint is informational only in SQLite).
UPDATE ip_addresses SET status = 'locked' WHERE status = 'reserved';
