import { DHCP_DEFAULT_NTP_SERVERS } from '../config/defaults.js';

export function createCustomOption(db, fields) {
  const result = db.prepare(`
    INSERT INTO dhcp_custom_options (code, name, label, type, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    fields.code,
    fields.name,
    fields.label,
    fields.type,
    fields.description || null
  );

  return {
    id: result.lastInsertRowid,
    code: fields.code,
    label: fields.label,
    type: fields.type
  };
}

export function deleteCustomOption(db, entry) {
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_custom_options WHERE code = ?').run(entry.code);
    db.prepare('DELETE FROM dhcp_option_defaults WHERE option_code = ?').run(entry.code);
    db.prepare('DELETE FROM dhcp_scope_options WHERE option_code = ?').run(entry.code);
  });

  del();
}

export function replaceDefaultOptions(db, options, enabledDefaults) {
  const enabledSet = new Set((enabledDefaults || []).map(Number));
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_option_defaults').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    const inserted = new Set();

    for (const opt of options) {
      if (opt.code && opt.value != null && opt.value !== '') {
        insert.run(opt.code, String(opt.value), enabledSet.has(Number(opt.code)) ? 1 : 0);
        inserted.add(Number(opt.code));
      }
    }

    for (const code of enabledSet) {
      if (!inserted.has(code)) {
        insert.run(code, null, 1);
      }
    }
  });

  replace();
  return getDefaultOptions(db);
}

export function seedDefaultOptions(db) {
  const seed = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(option_code) DO UPDATE SET
        enabled_by_default = CASE
          WHEN excluded.enabled_by_default = 1 THEN 1
          ELSE dhcp_option_defaults.enabled_by_default
        END
    `);

    for (const code of [1, 3, 6, 15, 119]) {
      insert.run(code, null, 1);
    }
    insert.run(42, DHCP_DEFAULT_NTP_SERVERS, 1);
    insert.run(51, '3600', 1);
  });

  seed();
}

export function getDefaultOptions(db) {
  const rows = db.prepare('SELECT option_code, value, enabled_by_default FROM dhcp_option_defaults').all();
  return {
    defaults: Object.fromEntries(rows.filter(r => r.value != null).map(r => [r.option_code, r.value])),
    enabledDefaults: rows.filter(r => r.enabled_by_default).map(r => r.option_code)
  };
}

export function cleanupRedundantGatewayOptions(db) {
  const result = db.prepare(`
    DELETE FROM dhcp_scope_options
    WHERE option_code = 3
      AND scope_id IN (
        SELECT s.id FROM dhcp_scopes s
        JOIN subnets sub ON s.subnet_id = sub.id
        WHERE sub.gateway_address IS NOT NULL
          AND sub.gateway_address != ''
      )
      AND value = (
        SELECT sub.gateway_address FROM dhcp_scopes s
        JOIN subnets sub ON s.subnet_id = sub.id
        WHERE s.id = dhcp_scope_options.scope_id
      )
  `).run();
  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} redundant gateway option(s) from DHCP scopes`);
  }
  return result.changes;
}

export function migrateLegacyScopeOptions(db) {
  const scopes = db.prepare('SELECT * FROM dhcp_scopes').all();
  const hasAny = db.prepare('SELECT COUNT(*) as c FROM dhcp_scope_options').get();
  if (hasAny.c > 0) return 0;

  const insert = db.prepare('INSERT OR IGNORE INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  const migrate = db.transaction(() => {
    for (const scope of scopes) {
      if (scope.gateway) {
        insert.run(scope.id, 3, scope.gateway);
      }
      if (scope.dns_servers) {
        try {
          const servers = JSON.parse(scope.dns_servers);
          if (Array.isArray(servers) && servers.length > 0) {
            insert.run(scope.id, 6, servers.join(','));
          }
        } catch { /* skip */ }
      }
      if (scope.domain_name) {
        insert.run(scope.id, 15, scope.domain_name);
      }
      if (scope.ntp_servers) {
        try {
          const servers = JSON.parse(scope.ntp_servers);
          if (Array.isArray(servers) && servers.length > 0) {
            insert.run(scope.id, 42, servers.join(','));
          }
        } catch { /* skip */ }
      }
      if (scope.domain_search) {
        insert.run(scope.id, 119, scope.domain_search);
      }
    }
  });

  migrate();
  if (scopes.length > 0) {
    console.log(`Migrated legacy DHCP options for ${scopes.length} scopes`);
  }
  return scopes.length;
}

export function upsertServerDnsDefault(db, value) {
  const existing = db.prepare('SELECT value FROM dhcp_option_defaults WHERE option_code = 6').get();
  if (existing?.value === value) return false;

  db.prepare(`
    INSERT INTO dhcp_option_defaults (option_code, value, updated_at)
    VALUES (6, ?, datetime('now'))
    ON CONFLICT(option_code) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(value, value);
  return true;
}
