-- DHCP lease duration is scope policy, not generic option 51 policy. Preserve
-- the previously emitted effective duration while removing the duplicate
-- authority. New scopes use the documented default_lease_time setting.
UPDATE dhcp_scopes
SET lease_time = COALESCE(
  (SELECT value || 's' FROM dhcp_scope_options
   WHERE scope_id = dhcp_scopes.id AND option_code = 51),
  (SELECT value || 's' FROM dhcp_option_defaults
   WHERE option_code = 51 AND enabled_by_default = 1),
  lease_time
);

DELETE FROM dhcp_scope_options WHERE option_code = 51;
DELETE FROM dhcp_option_defaults WHERE option_code = 51;
