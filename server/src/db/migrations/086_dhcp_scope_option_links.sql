-- DHCP default options are opt-in per scope (REVIEW.md DHCP-01). Until now a
-- default with a value was served to every scope with no row of its own for
-- that option. A scope now serves a default only through a linked row: a
-- dhcp_scope_options row whose value is NULL, which follows the default's
-- current value (models/dhcp-scope.js resolveEffectiveScopeOptions).

CREATE TABLE dhcp_scope_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  option_code INTEGER NOT NULL,
  value TEXT,
  address_family INTEGER NOT NULL DEFAULT 4 CHECK(address_family IN (4, 6)),
  UNIQUE(scope_id, address_family, option_code)
);
INSERT INTO dhcp_scope_options_new (id, scope_id, option_code, value, address_family)
  SELECT id, scope_id, option_code, value, address_family FROM dhcp_scope_options;
DROP TABLE dhcp_scope_options;
ALTER TABLE dhcp_scope_options_new RENAME TO dhcp_scope_options;
CREATE INDEX idx_scope_options_scope ON dhcp_scope_options(scope_id);

-- A default IPv6 scope made from a source scope (divide, merge) had its rows
-- copied without their family, so they were stored as IPv4. Give each row its
-- scope's family before anything is matched on it.
UPDATE OR IGNORE dhcp_scope_options
  SET address_family = (SELECT s.address_family FROM dhcp_scopes s WHERE s.id = scope_id)
  WHERE address_family != (SELECT s.address_family FROM dhcp_scopes s WHERE s.id = scope_id);

-- Keep what every scope serves today: link it to each default it was being
-- served, the ones with a value and no row of the scope's own. Option 51 never
-- came from a default (it is the scope's lease time).
INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family)
  SELECT s.id, d.option_code, NULL, d.address_family
  FROM dhcp_scopes s
  JOIN dhcp_option_defaults d ON d.address_family = s.address_family
  WHERE d.value IS NOT NULL
    AND d.option_code != 51
    AND NOT EXISTS (
      SELECT 1 FROM dhcp_scope_options o
      WHERE o.scope_id = s.id
        AND o.address_family = d.address_family
        AND o.option_code = d.option_code
    );
