-- DHCP defaults reach a scope only when it is created. The Use default model
-- of migration 086 (a dhcp_scope_options row with a NULL value that followed
-- the default's current value) is retired: every linked row becomes the
-- scope's own copy of what the scope was serving, so nothing served changes.

-- DHCPv6: the scope columns (dns_servers 23, domain_search 24, ntp_servers
-- 56) served over a link, and still serve beside a row of the scope's own
-- (models/dhcp-scope.js resolveEffectiveScopeOptions, the IPv6 layering), so
-- a link beside one went unserved. Drop it; the column keeps serving.
DELETE FROM dhcp_scope_options
  WHERE value IS NULL AND address_family = 6 AND option_code IN (23, 24, 56)
    AND EXISTS (
      SELECT 1 FROM dhcp_scopes s WHERE s.id = dhcp_scope_options.scope_id AND (
        (dhcp_scope_options.option_code = 23
          AND json_valid(s.dns_servers) AND json_array_length(s.dns_servers) > 0)
        OR (dhcp_scope_options.option_code = 24
          AND s.domain_search IS NOT NULL AND s.domain_search != '')
        OR (dhcp_scope_options.option_code = 56
          AND json_valid(s.ntp_servers) AND json_array_length(s.ntp_servers) > 0)
      )
    );

-- DHCPv4: a scope with no row of its own served its legacy columns
-- (domain_name 15, ntp_servers 42, domain_search 119) over its links, and
-- those columns stop applying once the scope has a row of its own. Copy them
-- in first, as own rows, for the scopes about to get some.
CREATE TEMP TABLE legacy_v4 AS
  SELECT s.id AS scope_id, s.domain_name, s.domain_search,
    CASE WHEN json_valid(s.ntp_servers) AND json_array_length(s.ntp_servers) > 0
      THEN (SELECT group_concat(j.value, ',') FROM json_each(s.ntp_servers) j)
    END AS ntp
  FROM dhcp_scopes s
  WHERE s.address_family = 4
    AND EXISTS (SELECT 1 FROM dhcp_scope_options o WHERE o.scope_id = s.id AND o.value IS NULL)
    AND NOT EXISTS (SELECT 1 FROM dhcp_scope_options o WHERE o.scope_id = s.id AND o.value IS NOT NULL);
UPDATE dhcp_scope_options SET value = (
    SELECT CASE option_code WHEN 15 THEN l.domain_name WHEN 42 THEN l.ntp WHEN 119 THEN l.domain_search END
    FROM legacy_v4 l WHERE l.scope_id = dhcp_scope_options.scope_id)
  WHERE value IS NULL AND address_family = 4 AND option_code IN (15, 42, 119)
    AND (SELECT CASE option_code WHEN 15 THEN l.domain_name WHEN 42 THEN l.ntp WHEN 119 THEN l.domain_search END
         FROM legacy_v4 l WHERE l.scope_id = dhcp_scope_options.scope_id) != '';
INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family)
  SELECT l.scope_id, c.code, c.value, 4
  FROM legacy_v4 l
  JOIN (
    SELECT scope_id, 15 AS code, domain_name AS value FROM legacy_v4
    UNION ALL SELECT scope_id, 42, ntp FROM legacy_v4
    UNION ALL SELECT scope_id, 119, domain_search FROM legacy_v4
  ) c ON c.scope_id = l.scope_id
  WHERE c.value IS NOT NULL AND c.value != ''
    AND NOT EXISTS (
      SELECT 1 FROM dhcp_scope_options o
      WHERE o.scope_id = l.scope_id AND o.address_family = 4 AND o.option_code = c.code
    );
DROP TABLE legacy_v4;

-- Every other link becomes the scope's own copy of the default it followed;
-- a link to a default with no value, which served nothing, is dropped.
UPDATE dhcp_scope_options
  SET value = (
    SELECT d.value FROM dhcp_option_defaults d
    WHERE d.address_family = dhcp_scope_options.address_family
      AND d.option_code = dhcp_scope_options.option_code
  )
  WHERE value IS NULL;
DELETE FROM dhcp_scope_options WHERE value IS NULL OR value = '';
