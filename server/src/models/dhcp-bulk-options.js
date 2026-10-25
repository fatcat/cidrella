/**
 * Bulk Change: give existing scopes of one family the option set the DHCP
 * defaults editor shows, the way a new scope gets it.
 *
 * A changed scope gets exactly the enabled options: everything else it had is
 * removed, including the pre-catalog scope columns (dns_servers, ntp_servers,
 * domain_search) that would otherwise keep serving 6, 42, 119 or 23, 24, 56.
 * A blank enabled option is filled from the scope's network by
 * fillScopeOptions, as for a new scope. Every value is the scope's own: the
 * defaults reach a scope only when it is created, and "make these my
 * defaults" only saves the editor's values as the defaults as well. A ticked
 * DHCPv4 Lease Time (51) with a value sets the scope's lease_time, and a
 * blank 51 leaves it alone. DHCPv6 has no lease-time option: `leaseTime`
 * (the editor's Address lifetime row, ticked) sets it, on a SLAAC-only scope
 * too, whose RA prefix lifetime it is; that scope's options stay as they are.
 * Pools are untouched.
 *
 * Preview and apply run the same code: preview does the writes in a
 * transaction, reads every scope's effective options, then rolls back. What a
 * preview shows is what an apply does.
 */

import { parseNetwork, getServerIpForSubnet } from '../utils/ip.js';
import { fillScopeOptions, writeScopeOptionRows } from '../services/subnet-dhcp-topology.js';
import { replaceDefaultOptions, saveDefaultAddressLifetime } from './dhcp-option.js';
import { getScopePools, resolveEffectiveScopeOptions, scopeAddressFamily } from './dhcp-scope.js';
import { isValidLeaseTime } from '../utils/lease-time.js';

const ROLLBACK = Symbol('bulk-options-preview');

const isSlaacOnly = (scope) => scopeAddressFamily(scope) === 6 && scope.v6_mode === 'slaac';

/**
 * A SLAAC-only DHCPv6 scope sends no options, so a bulk change skips it,
 * unless it sets the address lifetime, the one thing that scope takes.
 */
export function bulkChangeSkipReason(scope, { leaseTime = null } = {}) {
  if (isSlaacOnly(scope) && !leaseTime) return 'SLAAC only, sends no options';
  return null;
}

// The key a DHCPv6 address lifetime change is reported under: it is the
// scope's lease_time, not an option, so it has no code.
const ADDRESS_LIFETIME = 'address_lifetime';

function familyScopes(db, family) {
  return db
    .prepare(
      `
    SELECT s.*, sub.cidr AS subnet_cidr, sub.name AS subnet_name,
      sub.gateway_address AS subnet_gateway, sub.domain_name AS subnet_domain_name
    FROM dhcp_scopes s
    JOIN subnets sub ON s.subnet_id = sub.id
    ORDER BY sub.network_address, s.id
  `,
    )
    .all()
    .filter((scope) => scopeAddressFamily(scope) === family);
}

// Code to served value. The DHCPv4 lease time is reported as 51, the option
// the editor shows it as; the DHCPv6 one under ADDRESS_LIFETIME.
function effectiveMap(db, scope, family) {
  const fresh = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(scope.id);
  const effective = resolveEffectiveScopeOptions(db, { ...scope, ...fresh });
  const map = new Map(effective.options.map((option) => [option.option_code, option.value]));
  map.set(family === 4 ? 51 : ADDRESS_LIFETIME, effective.lease_time);
  return map;
}

// The lifetime first, then options by code. A change carries `code`, or
// `field` for the DHCPv6 address lifetime.
function diff(before, after) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a === ADDRESS_LIFETIME ? -1 : b === ADDRESS_LIFETIME ? 1 : a - b,
  );
  return keys
    .filter((key) => before.get(key) !== after.get(key))
    .map((key) => ({
      ...(key === ADDRESS_LIFETIME ? { code: null, field: ADDRESS_LIFETIME } : { code: key }),
      before: before.get(key) ?? null,
      after: after.get(key) ?? null,
    }));
}

function replaceScopeOptions(db, scope, family, enabled, leaseTime) {
  // A SLAAC-only scope takes the lifetime alone (bulkChangeSkipReason).
  if (isSlaacOnly(scope)) {
    db.prepare('UPDATE dhcp_scopes SET lease_time = ? WHERE id = ?').run(leaseTime, scope.id);
    return;
  }
  const parsed = parseNetwork(scope.subnet_cidr);
  const optionValues = fillScopeOptions(enabled, {
    parsed,
    gateway: scope.subnet_gateway,
    domain: scope.subnet_domain_name,
    serverIp: getServerIpForSubnet(scope.subnet_cidr),
  });
  // Lease time is the scope's lease_time field; writeScopeOptionRows never
  // stores DHCPv4 51 as a row.
  if (leaseTime) {
    db.prepare('UPDATE dhcp_scopes SET lease_time = ? WHERE id = ?').run(leaseTime, scope.id);
  }
  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scope.id);
  db.prepare(
    'UPDATE dhcp_scopes SET dns_servers = NULL, ntp_servers = NULL, domain_search = NULL WHERE id = ?',
  ).run(scope.id);
  writeScopeOptionRows(db, scope.id, family, optionValues);
}

/**
 * Run a bulk change. `options` is every value in the editor ({code, value}),
 * `enabled` the codes ticked to apply. `scopeIds` limits the writes; the
 * result still lists every scope of the family with what applying to it
 * would change, so a preview can pass every scope.
 *
 * With `saveDefaults` the family's defaults become the editor's too.
 */
export function bulkChangeScopeOptions(
  db,
  {
    family,
    options,
    enabled,
    leaseTime: addressLifetime = null,
    scopeIds = null,
    saveDefaults = false,
    preview = false,
  },
) {
  const enabledSet = new Set(enabled.map(Number));
  const values = new Map(options.map((option) => [Number(option.code), option.value]));
  const hasValue = (code) => values.get(code) != null && values.get(code) !== '';
  const enabledOptions = [...enabledSet].map((code) => ({ code, value: values.get(code) }));
  // The editor's 51 is seconds (its catalog type), which is a lease time as
  // stored; anything else is left out rather than written.
  let leaseTime = null;
  if (family === 6) leaseTime = addressLifetime;
  else if (enabledSet.has(51) && hasValue(51) && isValidLeaseTime(String(values.get(51)))) {
    leaseTime = String(values.get(51));
  }
  const only = scopeIds ? new Set(scopeIds.map(Number)) : null;

  let result;
  const run = db.transaction(() => {
    const scopes = familyScopes(db, family);
    const before = new Map(scopes.map((scope) => [scope.id, effectiveMap(db, scope, family)]));
    if (saveDefaults) {
      replaceDefaultOptions(db, options, [...enabledSet], family);
      if (family === 6 && leaseTime) saveDefaultAddressLifetime(db, leaseTime);
    }
    const touched = [];
    for (const scope of scopes) {
      if (bulkChangeSkipReason(scope, { leaseTime })) continue;
      if (only && !only.has(scope.id)) continue;
      replaceScopeOptions(db, scope, family, enabledOptions, leaseTime);
      touched.push(scope.id);
    }
    // In a preview every eligible scope is written, so each one's change can
    // be read back whether or not it is selected.
    result = {
      family,
      applied: touched,
      scopes: scopes.map((scope) => ({
        id: scope.id,
        subnet_id: scope.subnet_id,
        subnet_cidr: scope.subnet_cidr,
        subnet_name: scope.subnet_name,
        description: scope.description,
        enabled: Boolean(scope.enabled),
        v6_mode: scope.v6_mode ?? null,
        pools: getScopePools(db, scope.id).map(({ start_ip, end_ip }) => ({ start_ip, end_ip })),
        skip_reason: bulkChangeSkipReason(scope, { leaseTime }),
        changes: diff(before.get(scope.id), effectiveMap(db, scope, family)),
      })),
    };
    if (preview) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return result;
}
