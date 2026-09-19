-- First-run setup state.
--
-- settings.setup_state is a JSON object with one marker per wizard step
-- ({ password, deployment, import, done }) so an interrupted first run resumes
-- at the unfinished step instead of replaying what was already saved.
--
-- Existing installs must never see the wizard. Anything that shows the
-- appliance has been used is proof enough: a network exists, a user has
-- changed their password, or the classic network wizard was completed. A
-- fresh database has none of these when this runs: migrations apply before
-- ensureDefaults() seeds the admin, so the row stays absent and the default
-- ({"done":false}) takes over.

INSERT INTO settings (key, value)
SELECT 'setup_state', '{"done":true,"source":"upgrade"}'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'setup_state')
  AND (
    EXISTS (SELECT 1 FROM subnets)
    OR EXISTS (SELECT 1 FROM users WHERE must_change_password = 0)
    OR EXISTS (
      SELECT 1 FROM settings
      WHERE key = 'setup_wizard_completed' AND value IN ('1', 'true')
    )
  );
