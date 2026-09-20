-- Two settings changes for the first-run work.
--
-- 1. The password rule is now four settings (password_min_length,
--    password_require_mixed_case, password_require_number,
--    password_require_symbol) instead of one on/off switch
--    (password_complexity, which only 0.5.0-pre.2 ever wrote). An appliance
--    that had switched it off keeps the effect: mixed case and number off.
--    The switch's row is removed so nothing reads a stale key.
--
-- 2. DHCP is off by default on a fresh install: dnsmasq should not answer
--    DHCP on every interface before the operator has said what the box is.
--    Migration 033 seeds dhcp_enabled = 'true' into every database, so the
--    flip is an update, and only for a database nothing has been done with:
--    no network, no user who has changed their password, no finished wizard.
--    Migrations run before the admin is seeded, so a fresh database has no
--    users at all here. An install in use keeps its 'true'.

INSERT INTO settings (key, value)
SELECT 'password_require_mixed_case', 'false'
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'password_complexity' AND value = 'false')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'password_require_mixed_case');

INSERT INTO settings (key, value)
SELECT 'password_require_number', 'false'
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'password_complexity' AND value = 'false')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'password_require_number');

DELETE FROM settings WHERE key = 'password_complexity';

UPDATE settings SET value = 'false'
WHERE key = 'dhcp_enabled'
  AND NOT EXISTS (SELECT 1 FROM subnets)
  AND NOT EXISTS (SELECT 1 FROM users WHERE must_change_password = 0)
  AND NOT EXISTS (
    SELECT 1 FROM settings WHERE key = 'setup_wizard_completed' AND value IN ('1', 'true')
  )
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'setup_state' AND value LIKE '%"done":true%');
