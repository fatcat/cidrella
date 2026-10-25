import os from 'os';
import {
  DEFAULTS,
  DHCP_DEFAULT_NTP_SERVERS,
  DHCP6_DEFAULT_NTP_SERVERS,
} from '../config/defaults.js';
import { isValidLeaseTime } from '../utils/lease-time.js';
import { readSetting, upsertSetting } from './setting.js';

// DHCPv4 and DHCPv6 option codes are separate namespaces, so every table here
// is keyed by (address_family, code). Callers that never learned about
// families get IPv4, which is what every row was before migration 072.
function familyOf(value) {
  return Number(value) === 6 ? 6 : 4;
}

export function createCustomOption(db, fields) {
  const family = familyOf(fields.address_family);
  const result = db
    .prepare(
      `
    INSERT INTO dhcp_custom_options (code, name, label, type, description, address_family)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(fields.code, fields.name, fields.label, fields.type, fields.description || null, family);

  return {
    id: result.lastInsertRowid,
    code: fields.code,
    label: fields.label,
    type: fields.type,
    address_family: family,
  };
}

export function deleteCustomOption(db, entry) {
  const family = familyOf(entry.address_family);
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_custom_options WHERE code = ? AND address_family = ?').run(
      entry.code,
      family,
    );
    db.prepare('DELETE FROM dhcp_option_defaults WHERE option_code = ? AND address_family = ?').run(
      entry.code,
      family,
    );
    db.prepare('DELETE FROM dhcp_scope_options WHERE option_code = ? AND address_family = ?').run(
      entry.code,
      family,
    );
  });

  del();
}

export function replaceDefaultOptions(db, options, enabledDefaults, family = 4) {
  const fam = familyOf(family);
  const enabledSet = new Set((enabledDefaults || []).map(Number));
  // Every scope has a lease time, so the DHCPv4 Lease Time (51) default is
  // always added to new scopes; the editors lock its checkbox.
  if (fam === 4) enabledSet.add(LEASE_TIME_OPTION);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_option_defaults WHERE address_family = ?').run(fam);
    const insert = db.prepare(`
      INSERT INTO dhcp_option_defaults
        (option_code, value, enabled_by_default, updated_at, address_family)
      VALUES (?, ?, ?, datetime('now'), ?)
    `);
    const inserted = new Set();

    for (const opt of options) {
      if (opt.code && opt.value != null && opt.value !== '') {
        insert.run(opt.code, String(opt.value), enabledSet.has(Number(opt.code)) ? 1 : 0, fam);
        inserted.add(Number(opt.code));
      }
    }

    for (const code of enabledSet) {
      if (!inserted.has(code)) {
        insert.run(code, null, 1, fam);
      }
    }
  });

  replace();
  return getDefaultOptions(db, fam);
}

/**
 * The defaults CIDRella ships, per family: every one enabled by default, most
 * with no value so a scope fills it from its network. IPv4: mask, router,
 * DNS, domain, search list and the baked NTP pool. IPv6: DNS servers (23) and
 * the search list (24), so a new scope gets CIDRella's own address on the
 * network and the network's domain, and the baked IPv6 NTP pool (56).
 */
export const SHIPPED_DEFAULT_OPTIONS = Object.freeze({
  4: Object.freeze([
    { code: 1, value: null },
    { code: 3, value: null },
    { code: 6, value: null },
    { code: 15, value: null },
    { code: 119, value: null },
    { code: 42, value: DHCP_DEFAULT_NTP_SERVERS },
    // The lease time a new scope starts with, in seconds (defaultLeaseTime).
    { code: 51, value: '3600' },
  ]),
  6: Object.freeze([
    { code: 23, value: null },
    { code: 24, value: null },
    { code: 56, value: DHCP6_DEFAULT_NTP_SERVERS },
  ]),
});

/**
 * Seed SHIPPED_DEFAULT_OPTIONS for both families. A row an install already
 * has keeps its value.
 */
export function seedDefaultOptions(db) {
  const seed = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO dhcp_option_defaults
        (option_code, value, enabled_by_default, updated_at, address_family)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(address_family, option_code) DO UPDATE SET
        enabled_by_default = CASE
          WHEN excluded.enabled_by_default = 1 THEN 1
          ELSE dhcp_option_defaults.enabled_by_default
        END
    `);

    for (const family of [4, 6]) {
      for (const { code, value } of SHIPPED_DEFAULT_OPTIONS[family]) {
        insert.run(code, value, 1, family);
      }
    }
  });

  seed();
}

const LEASE_TIME_OPTION = 51;

/**
 * The lease time a new scope starts with. DHCPv4: the Lease Time (51) row of
 * the defaults editor (shipped as 3600, always added to new scopes). DHCPv6
 * has no lease-time option, so its default, the Address lifetime row of the
 * DHCPv6 editor, is the `default_lease_time` setting; DHCPv4 falls back to it
 * only when its 51 row holds no lease time. Like every default, it is copied
 * at creation: lease time is always the scope's own.
 */
export function defaultLeaseTime(db, family = 4) {
  if (familyOf(family) === 4) {
    const row = db
      .prepare(
        'SELECT value FROM dhcp_option_defaults WHERE address_family = 4 AND option_code = ? AND enabled_by_default = 1',
      )
      .get(LEASE_TIME_OPTION);
    if (row && isValidLeaseTime(String(row.value ?? ''))) return String(row.value);
  }
  return readSetting(db, 'default_lease_time') ?? DEFAULTS.default_lease_time;
}

/**
 * Save the DHCPv6 Address lifetime default (see defaultLeaseTime). DHCPv4's
 * is its 51 row, saved with the other options.
 */
export function saveDefaultAddressLifetime(db, leaseTime) {
  upsertSetting(db, 'default_lease_time', String(leaseTime));
}

export function getDefaultOptions(db, family = 4) {
  const rows = db
    .prepare(
      'SELECT option_code, value, enabled_by_default FROM dhcp_option_defaults WHERE address_family = ?',
    )
    .all(familyOf(family));
  return {
    defaults: Object.fromEntries(
      rows.filter((r) => r.value != null).map((r) => [r.option_code, r.value]),
    ),
    enabledDefaults: rows.filter((r) => r.enabled_by_default).map((r) => r.option_code),
  };
}

export function cleanupRedundantGatewayOptions(db) {
  const result = db
    .prepare(
      `
    DELETE FROM dhcp_scope_options
    WHERE option_code = 3
      AND address_family = 4
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
  `,
    )
    .run();
  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} redundant gateway option(s) from DHCP scopes`);
  }
  return result.changes;
}

export function migrateLegacyScopeOptions(db) {
  const scopes = db.prepare('SELECT * FROM dhcp_scopes WHERE address_family = 4').all();
  const hasAny = db.prepare('SELECT COUNT(*) as c FROM dhcp_scope_options').get();
  if (hasAny.c > 0) return 0;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)',
  );
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
        } catch {
          /* skip */
        }
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
        } catch {
          /* skip */
        }
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

// IPv4 only by design: the host's IPv4 address is stable enough to bake into
// the DNS Servers default, a global IPv6 address is not (SLAAC, privacy
// extensions), so the IPv6 generator resolves the server address per scope.
export function upsertServerDnsDefault(db, value) {
  const existing = db
    .prepare('SELECT value FROM dhcp_option_defaults WHERE option_code = 6 AND address_family = 4')
    .get();
  if (existing?.value === value) return false;

  db.prepare(
    `
    INSERT INTO dhcp_option_defaults (option_code, value, updated_at, address_family)
    VALUES (6, ?, datetime('now'), 4)
    ON CONFLICT(address_family, option_code) DO UPDATE SET value = ?, updated_at = datetime('now')
  `,
  ).run(value, value);
  return true;
}

// The address CIDRella last put in the DNS Servers default, so a later boot
// can tell its own entry from the ones a person set.
const SERVER_DNS_SETTING = 'dhcp_dns_default_server_ip';

/**
 * The DNS Servers default (option 6) once the server's address is `serverIp`.
 * Only CIDRella's own entry follows the host: `previousIp` is the address it
 * wrote last, and on an install from before it was kept, the first entry,
 * where it always wrote it. Every other entry is a person's choice and stays,
 * (a resolver removed stays removed). An empty default is seeded with the
 * server alone, as networkOptionFills fills a scope.
 */
export function serverDnsDefaultValue(existing, serverIp, previousIp) {
  const list = (existing || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return serverIp;
  if (list.includes(serverIp)) return existing;
  const own = previousIp ? list.indexOf(previousIp) : 0;
  if (own < 0) return existing;
  list[own] = serverIp;
  return list.join(',');
}

/**
 * Detect the server's primary IPv4 address and put it in the DNS Servers
 * global default (option 6), by serverDnsDefaultValue. Runs at startup so a
 * host IP change is always reflected.
 */
export function syncServerDnsDefault(db) {
  // Find the first non-internal IPv4 address
  const ifaces = os.networkInterfaces();
  let serverIp = null;
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        serverIp = addr.address;
        break;
      }
    }
    if (serverIp) break;
  }

  if (!serverIp) {
    console.warn('Could not detect server IPv4 address for DNS default');
    return;
  }

  const existing = db
    .prepare('SELECT value FROM dhcp_option_defaults WHERE option_code = 6 AND address_family = 4')
    .get()?.value;
  const newValue = serverDnsDefaultValue(existing, serverIp, readSetting(db, SERVER_DNS_SETTING));
  upsertSetting(db, SERVER_DNS_SETTING, serverIp);

  if (upsertServerDnsDefault(db, newValue)) {
    console.log(`DNS Servers default updated: ${newValue}`);
  }
}
