/**
 * The DHCP scopes as every backend serves them: which scopes are live, their
 * pools and the addresses carved out of them, the lease time, and each
 * option's final value with the fallbacks applied and hostnames resolved to
 * addresses. An adapter renders this in its own syntax (dnsmasq config
 * lines, Kea JSON) and decides nothing about which option a scope gets.
 */
import { execFileSync } from 'child_process';
import { parseNetwork, isValidAddress, getServerIpForSubnet } from '../../utils/ip.js';
import { addressFamily, isValidIpv6 } from '../../utils/address.js';
import { generateFallbackHostname } from '../../utils/mac-vendor.js';
import { macFromDuid } from '../../utils/duid.js';
import { DHCP_OPTIONS_BY_CODE, optionCatalogFor } from '../../utils/dhcp-options.js';
import { validateConfigSafeValue } from '../../utils/config-value-validation.js';
import { resolveEffectiveScopeOptions } from '../../models/dhcp-scope.js';
import { ipv6Enabled } from '../../utils/ipv6-support.js';

/**
 * Resolve a hostname to an address of `family` with getent. One resolver
 * per load, so a name is looked up once per pass and a later pass sees DNS
 * changes.
 */
function createResolver() {
  const cache = new Map();
  return function resolveToIp(value, family) {
    if (isValidAddress(value)) return addressFamily(value) === family ? value : null;
    const key = `${family}|${value}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      const database = family === 6 ? 'ahostsv6' : 'ahostsv4';
      const out = execFileSync('getent', [database, value], { timeout: 3000, encoding: 'utf-8' });
      const ip = out.split('\n')[0]?.split(/\s+/)[0];
      result = ip && isValidAddress(ip) && addressFamily(ip) === family ? ip : null;
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/**
 * One option value ready to write, or null when nothing safe can be: address
 * types become `addresses` (hostnames resolved in the family), everything
 * else `text`. Every value passes the config-safety guard.
 */
function optionValue(value, type, family, resolve) {
  if (type === 'ip' || type === 'ip-list') {
    const addresses = value
      .split(',')
      .map((part) => resolve(part.trim(), family))
      .filter(Boolean);
    if (addresses.length === 0) return null;
    return validateConfigSafeValue(addresses.join(','), { allowComma: true }) == null
      ? { addresses }
      : null;
  }
  const guard = type === 'text-list' ? { allowComma: true } : undefined;
  return validateConfigSafeValue(value, guard) == null ? { text: value } : null;
}

// A legacy JSON server-list column, as a comma list under `code`.
function setServerList(merged, code, column) {
  if (!column || merged.has(code)) return;
  try {
    const servers = JSON.parse(column);
    if (Array.isArray(servers) && servers.length > 0) merged.set(code, servers.join(','));
  } catch {
    /* skip */
  }
}

// DHCPv4: the scope's effective options, then the legacy columns of a scope
// with none, then the network's gateway and domain. Option 51 moves into the
// lease time; 1 and 28 come from the pool's mask, never an option row.
function v4Options(scope, effective) {
  const merged = new Map();
  for (const opt of effective.options) merged.set(opt.option_code, opt.value);
  if (effective.options.length === 0) {
    const gw = scope.gateway || scope.subnet_gateway;
    if (gw && !merged.has(3)) merged.set(3, gw);
    setServerList(merged, 6, scope.dns_servers);
    if (scope.domain_name && !merged.has(15)) merged.set(15, scope.domain_name);
    setServerList(merged, 42, scope.ntp_servers);
    if (scope.domain_search && !merged.has(119)) merged.set(119, scope.domain_search);
  }
  if (!merged.has(3) && scope.subnet_gateway) merged.set(3, scope.subnet_gateway);
  if (!merged.has(15) && scope.subnet_domain_name) merged.set(15, scope.subnet_domain_name);
  if (!merged.has(119) && scope.subnet_domain_name) merged.set(119, scope.subnet_domain_name);

  let leaseTime = scope.lease_time;
  if (merged.has(51)) {
    leaseTime = `${merged.get(51)}s`;
    merged.delete(51);
  }
  merged.delete(1);
  merged.delete(28);
  return { merged, leaseTime };
}

// DHCPv6: the effective options, with CIDRella's own address as the DNS
// server when nothing else names one. Ordered by code; internal codes the
// server builds itself are left out.
function v6Options(scope, effective) {
  const merged = new Map();
  for (const opt of effective.options) {
    const code = Number(opt.option_code ?? opt.code);
    if (opt.value != null && opt.value !== '') merged.set(code, String(opt.value));
  }
  if (!merged.has(23)) {
    const serverIp = getServerIpForSubnet(scope.subnet_cidr);
    if (serverIp) merged.set(23, serverIp);
  }
  const internal = optionCatalogFor(6).internalCodes;
  return new Map([...merged].filter(([code]) => !internal.has(code)).sort((a, b) => a[0] - b[0]));
}

/**
 * Every live scope (enabled, on an allocated network; an IPv6 one only while
 * IPv6 support is on) as:
 *   { scope, family, network, prefix, netmask, mode, leaseTime, pools,
 *     excludedIps, suppressRouter,
 *     options: [{ code, type, custom, addresses | text }] }
 * `scope` is the row with subnet fields joined. `mode` is the DHCPv6 mode
 * (stateful, stateless, slaac), null for DHCPv4. DHCPv4 options are in the
 * order they were merged, DHCPv6 options by code. `custom` marks a code
 * from dhcp_custom_options rather than the catalog.
 */
export function loadDhcpScopes(db) {
  const resolve = createResolver();
  const scopes = db
    .prepare(
      `
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.gateway_address as subnet_gateway,
      sub.network_address, sub.prefix_length, sub.domain_name as subnet_domain_name,
      sub.broadcast_address as subnet_broadcast
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1 AND sub.status = 'allocated'
  `,
    )
    .all();

  const reservedBySubnet = new Map();
  for (const row of db
    .prepare("SELECT subnet_id, ip_address FROM ip_addresses WHERE allocation_state = 'reserved'")
    .all()) {
    if (!reservedBySubnet.has(row.subnet_id)) reservedBySubnet.set(row.subnet_id, []);
    reservedBySubnet.get(row.subnet_id).push(row.ip_address);
  }

  // Custom option types by family, so a user-defined code can be written.
  const customTypes = { 4: new Map(), 6: new Map() };
  for (const row of db
    .prepare('SELECT code, type, address_family FROM dhcp_custom_options')
    .all()) {
    customTypes[row.address_family === 6 ? 6 : 4].set(Number(row.code), row.type || 'text');
  }

  const poolsFor = db.prepare(
    'SELECT start_ip, end_ip FROM dhcp_scope_pools WHERE scope_id = ? ORDER BY sort_order, id',
  );
  const ipv6 = ipv6Enabled();
  const live = [];
  for (const scope of scopes) {
    const parsed = parseNetwork(scope.subnet_cidr);
    if (parsed.family === 6 && !ipv6) continue;
    const effective = resolveEffectiveScopeOptions(db, scope);
    scope.lease_time = effective.lease_time;
    const pools = poolsFor.all(scope.id);
    const family = parsed.family;
    const { merged, leaseTime } =
      family === 6
        ? { merged: v6Options(scope, effective), leaseTime: scope.lease_time }
        : v4Options(scope, effective);
    const options = [];
    for (const [code, value] of merged) {
      const catalogType =
        family === 6 ? optionCatalogFor(6).byCode[code]?.type : DHCP_OPTIONS_BY_CODE[code]?.type;
      const type = catalogType || customTypes[family].get(Number(code));
      if (!type || !value) continue;
      const rendered = optionValue(String(value), type, family, resolve);
      if (rendered) options.push({ code: Number(code), type, custom: !catalogType, ...rendered });
    }
    live.push({
      scope,
      family,
      network: parsed.network,
      prefix: parsed.prefix,
      netmask: parsed.mask,
      mode: family === 6 ? scope.v6_mode || 'stateful' : null,
      leaseTime,
      pools,
      excludedIps: reservedBySubnet.get(scope.subnet_id) || [],
      suppressRouter: family === 4 && effective.router_suppressed === true,
      options,
    });
  }
  return live;
}

/**
 * Every enabled reservation on an allocated network, by address, as
 *   { subnetId, family, mac, duid, iaid, ip, hostname }.
 * A reservation without a name gets the vendor fallback name from its MAC
 * (for DHCPv6, the MAC inside its DUID when there is one). A DHCPv6 one
 * needs a DUID and an IPv6 address, or no server can match it, and is left
 * out.
 */
export function loadDhcpReservations(db) {
  return db
    .prepare(
      `
    SELECT r.* FROM dhcp_reservations r
    JOIN subnets sub ON sub.id = r.subnet_id
    WHERE r.enabled = 1 AND sub.status = 'allocated' ORDER BY r.ip_address
  `,
    )
    .all()
    .flatMap((r) => {
      const family = r.address_family === 6 ? 6 : 4;
      if (family === 6 && (!r.duid || !isValidIpv6(r.ip_address))) return [];
      const vendorMac = r.mac_address || (family === 6 ? macFromDuid(r.duid) : null);
      return [
        {
          subnetId: r.subnet_id,
          family,
          mac: r.mac_address || null,
          duid: r.duid || null,
          iaid: r.iaid ?? null,
          ip: r.ip_address,
          hostname: r.hostname || (vendorMac ? generateFallbackHostname(vendorMac) : null),
        },
      ];
    });
}
