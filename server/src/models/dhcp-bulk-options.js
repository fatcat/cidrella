/**
 * Bulk Change: give existing scopes of one family the option set the DHCP
 * defaults editor shows, the way a new scope gets it.
 *
 * A changed scope gets exactly the enabled options: everything else it had is
 * removed, including the pre-catalog scope columns (dns_servers, ntp_servers,
 * domain_search) that would otherwise keep serving 6, 42, 119 or 23, 24, 56.
 * A blank enabled option is filled from the scope's network by
 * fillScopeOptions, as for a new scope. When the editor's values become the
 * defaults too, an option with a value is linked to its default (Use
 * default), so later edits of the default reach the scope; otherwise the
 * scope gets the value as its own. Lease time and pools are untouched.
 *
 * Preview and apply run the same code: preview does the writes in a
 * transaction, reads every scope's effective options, then rolls back. What a
 * preview shows is what an apply does.
 */

import { parseNetwork, getServerIpForSubnet } from '../utils/ip.js';
import {
  fillScopeOptions,
  writeScopeOptionRows,
  USE_DEFAULT,
} from '../services/subnet-dhcp-topology.js';
import { replaceDefaultOptions } from './dhcp-option.js';
import { getScopePools, resolveEffectiveScopeOptions, scopeAddressFamily } from './dhcp-scope.js';

const ROLLBACK = Symbol('bulk-options-preview');

/** A SLAAC-only DHCPv6 scope sends no options, so a bulk change skips it. */
export function bulkChangeSkipReason(scope) {
  if (scopeAddressFamily(scope) === 6 && scope.v6_mode === 'slaac') {
    return 'SLAAC only, sends no options';
  }
  return null;
}

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

// Code to { value, linked }: linked when the value is the default's (Use default).
function effectiveMap(db, scope) {
  const fresh = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(scope.id);
  const options = resolveEffectiveScopeOptions(db, { ...scope, ...fresh }).options;
  return new Map(
    options.map((option) => [
      option.option_code,
      { value: option.value, linked: option.source === 'default' },
    ]),
  );
}

// A change is a different value, or the same value moving to or from the default.
function diff(before, after) {
  const codes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  return codes
    .filter(
      (code) =>
        before.get(code)?.value !== after.get(code)?.value ||
        !!before.get(code)?.linked !== !!after.get(code)?.linked,
    )
    .map((code) => ({
      code,
      before: before.get(code)?.value ?? null,
      after: after.get(code)?.value ?? null,
      before_default: !!before.get(code)?.linked,
      after_default: !!after.get(code)?.linked,
    }));
}

function replaceScopeOptions(db, scope, family, enabled) {
  const parsed = parseNetwork(scope.subnet_cidr);
  const optionValues = fillScopeOptions(enabled, {
    parsed,
    gateway: scope.subnet_gateway,
    domain: scope.subnet_domain_name,
    serverIp: getServerIpForSubnet(scope.subnet_cidr),
  });
  // Lease time is the scope's lease_time field, never an option row.
  if (family === 4) optionValues.delete(51);
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
 * With `saveDefaults` the family's defaults become the editor's too, first,
 * and each enabled option with a value is linked to its default.
 */
export function bulkChangeScopeOptions(
  db,
  { family, options, enabled, scopeIds = null, saveDefaults = false, preview = false },
) {
  const enabledSet = new Set(enabled.map(Number));
  const values = new Map(options.map((option) => [Number(option.code), option.value]));
  const hasValue = (code) => values.get(code) != null && values.get(code) !== '';
  const enabledOptions = [...enabledSet].map((code) => ({
    code,
    value: saveDefaults && hasValue(code) ? USE_DEFAULT : values.get(code),
  }));
  const only = scopeIds ? new Set(scopeIds.map(Number)) : null;

  let result;
  const run = db.transaction(() => {
    const scopes = familyScopes(db, family);
    const before = new Map(scopes.map((scope) => [scope.id, effectiveMap(db, scope)]));
    if (saveDefaults) replaceDefaultOptions(db, options, [...enabledSet], family);
    const touched = [];
    for (const scope of scopes) {
      if (bulkChangeSkipReason(scope)) continue;
      if (only && !only.has(scope.id)) continue;
      replaceScopeOptions(db, scope, family, enabledOptions);
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
        skip_reason: bulkChangeSkipReason(scope),
        changes: diff(before.get(scope.id), effectiveMap(db, scope)),
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
