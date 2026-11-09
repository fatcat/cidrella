-- offline_metadata_retention_days was replaced by a fixed window
-- (OFFLINE_RETIREMENT_MS in services/ip-lifecycle-service.js) and nothing
-- reads it, but installs kept the stored row, which reads as a 7 day window
-- that does not apply. The settings route refuses the key already.
DELETE FROM settings WHERE key = 'offline_metadata_retention_days';
