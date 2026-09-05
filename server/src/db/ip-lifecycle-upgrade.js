import fs from 'fs';
import path from 'path';
import { canonicalizeIp, parseIp } from '../utils/address.js';
import { localIpv4Set } from '../utils/local-addresses.js';
import { writeMigratedIpLifecycleRows } from './ip-identity.js';

export const LIFECYCLE_MIGRATION_REPORT = 'ip-lifecycle-migration-report.json';

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function columnExists(db, table, column) {
  return tableExists(db, table)
    && db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function identityKey(subnetId, ip) {
  return `${subnetId}|${canonicalizeIp(ip) || ip}`;
}

function containsAddress(start, end, ip) {
  const first = parseIp(start);
  const last = parseIp(end);
  const value = parseIp(ip);
  return Boolean(first && last && value
    && first.bits === value.bits && last.bits === value.bits
    && value.value >= first.value && value.value <= last.value);
}

function subnetContains(subnet, ip) {
  const network = parseIp(subnet.network_address);
  const value = parseIp(ip);
  if (!network || !value || network.bits !== value.bits) return false;
  const size = 1n << BigInt(network.bits - Number(subnet.prefix_length));
  return value.value >= network.value && value.value < network.value + size;
}

function bestSubnet(subnets, ip) {
  return subnets
    .filter(subnet => subnet.status === 'allocated' && subnetContains(subnet, ip))
    .sort((left, right) => Number(right.prefix_length) - Number(left.prefix_length))[0] || null;
}

function naturalList(values) {
  const items = values.filter(Boolean);
  if (items.length < 2) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function subnetLabel(subnet) {
  if (!subnet) return 'an unknown subnet';
  return subnet.name ? `${subnet.cidr} (${subnet.name})` : subnet.cidr;
}

function dnsHostname(record) {
  return record.name === '@' ? record.zone_name : `${record.name}.${record.zone_name}`;
}

function dnsLabel(record) {
  return `host ${dnsHostname(record)} (${record.type} record ${record.id})`;
}

function reservationLabel(reservation) {
  const hostname = reservation.hostname ? ` for host ${reservation.hostname}` : '';
  const mac = reservation.mac_address ? `, MAC ${reservation.mac_address}` : '';
  return `DHCP reservation ${reservation.id}${hostname}${mac}`;
}

function leaseLabel(lease) {
  const hostname = lease.hostname ? ` for host ${lease.hostname}` : '';
  const mac = lease.mac_address ? `, MAC ${lease.mac_address}` : '';
  return `DHCP lease ${lease.id}${hostname}${mac}`;
}

function scopeLabel(scope) {
  const description = scope.description ? ` (${scope.description})` : '';
  return `DHCP scope ${scope.id}${description}, ${scope.start_ip}-${scope.end_ip}`;
}

function isLinkLocalV6(ip) {
  const parsed = parseIp(ip);
  return Boolean(parsed && parsed.bits === 128
    && parsed.value >= 0xfe800000000000000000000000000000n
    && parsed.value <= 0xfebfffffffffffffffffffffffffffffn);
}

function loadFacts(db, { localAddresses = localIpv4Set() } = {}) {
  const subnets = db.prepare(`
    SELECT id, cidr, name, network_address, broadcast_address, gateway_address,
           prefix_length, status
    FROM subnets
  `).all();
  const scopes = db.prepare(`
    SELECT scope.id, scope.subnet_id, scope.enabled, range.start_ip, range.end_ip,
           range.description
    FROM dhcp_scopes scope
    JOIN ranges range ON range.id = scope.range_id
  `).all();
  const ips = db.prepare('SELECT * FROM ip_addresses').all();
  const reservations = db.prepare(
    'SELECT * FROM dhcp_reservations WHERE enabled = 1'
  ).all();
  const leases = db.prepare(`
    SELECT * FROM dhcp_leases
    WHERE expires_at = 'infinite' OR datetime(expires_at) > datetime('now')
  `).all();
  const dns = db.prepare(`
    SELECT record.id, record.name, record.type, record.value AS ip_address,
           zone.name AS zone_name
    FROM dns_records record
    JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE record.type IN ('A', 'AAAA')
      AND record.enabled = 1
      AND zone.enabled = 1
      AND zone.type = 'forward'
      AND COALESCE(record.source, 'manual') = 'manual'
  `).all().map(record => ({ ...record, subnet: bestSubnet(subnets, record.ip_address) }))
    .filter(record => record.subnet);

  const ipByKey = new Map();
  for (const row of ips) {
    const key = identityKey(row.subnet_id, row.ip_address);
    if (!ipByKey.has(key)) ipByKey.set(key, []);
    ipByKey.get(key).push(row);
  }
  const reservationByKey = new Map(reservations.map(row => [
    identityKey(row.subnet_id, row.ip_address), row
  ]));
  const leaseByKey = new Map(leases.map(row => [
    identityKey(row.subnet_id, row.ip_address), row
  ]));
  const dnsByKey = new Map();
  for (const row of dns) {
    const key = identityKey(row.subnet.id, row.ip_address);
    if (!dnsByKey.has(key)) dnsByKey.set(key, []);
    dnsByKey.get(key).push(row);
  }

  const subnetById = new Map(subnets.map(row => [row.id, row]));
  const inEnabledPool = (subnetId, ip) => scopes.some(scope => (
    scope.enabled === 1 && scope.subnet_id === subnetId
    && containsAddress(scope.start_ip, scope.end_ip, ip)
  ));
  const protectedKind = (subnetId, ip) => {
    const subnet = subnetById.get(subnetId);
    const canonical = canonicalizeIp(ip) || ip;
    if (!subnet) return null;
    if (canonical === canonicalizeIp(subnet.gateway_address)) return 'gateway';
    if (canonical === canonicalizeIp(subnet.network_address)
        || canonical === canonicalizeIp(subnet.broadcast_address)
        || localAddresses.has(canonical)) return 'system';
    return null;
  };

  return {
    subnets, scopes, ips, reservations, leases, dns,
    ipByKey, reservationByKey, leaseByKey, dnsByKey, subnetById,
    inEnabledPool, protectedKind, localAddresses
  };
}

function issueKey(category, subnetId, ip) {
  return `${category}|${subnetId}|${canonicalizeIp(ip) || ip}`;
}

function canNameProtectedAddress(facts, subnetId, ip) {
  const subnet = facts.subnetById.get(subnetId);
  const canonical = canonicalizeIp(ip) || ip;
  return Boolean(subnet && (
    canonical === canonicalizeIp(subnet.gateway_address)
    || facts.localAddresses.has(canonical)
  ));
}

export function inventoryLegacyIpLifecycle(db, options = {}) {
  const facts = loadFacts(db, options);
  const issues = new Map();
  const addIssue = (category, subnetId, ip, reason, remediation, affectedResources = []) => {
    const canonical = canonicalizeIp(ip) || ip;
    const key = issueKey(category, subnetId, canonical);
    const existing = issues.get(key);
    if (existing) {
      existing.affected_resources = [...new Set([
        ...existing.affected_resources,
        ...affectedResources
      ])];
      existing.reason = `${existing.reason} ${reason}`;
      existing.remediation = `${existing.remediation} ${remediation}`;
      return;
    }
    issues.set(key, {
      category,
      subnet_id: subnetId,
      subnet: subnetLabel(facts.subnetById.get(subnetId)),
      ip_address: canonical,
      affected_resources: affectedResources,
      reason,
      remediation
    });
  };

  for (const [key, records] of facts.dnsByKey) {
    if (records.length < 2) continue;
    const [subnetText, ip] = key.split('|');
    const recordNames = records.map(dnsHostname);
    const recordType = records.every(record => record.type === records[0].type)
      ? `${records[0].type} records`
      : 'address records';
    addIssue(
      'multiple_static_dns_names', Number(subnetText), ip,
      `${naturalList(recordNames.map(name => `Host ${name}`))} are enabled ${recordType} for the same IP ${ip}.`,
      `Choose one host to keep as the ${records[0].type} record for ${ip}. Convert every other host name to a CNAME record that targets the chosen host.`,
      records.map(dnsLabel)
    );
  }

  for (const record of facts.dns) {
    const subnetId = record.subnet.id;
    const ip = record.ip_address;
    const key = identityKey(subnetId, ip);
    const matchingScopes = facts.scopes.filter(scope => (
      scope.enabled === 1 && scope.subnet_id === subnetId
      && containsAddress(scope.start_ip, scope.end_ip, ip)
    ));
    if (matchingScopes.length) {
      addIssue(
        'manual_dns_inside_dynamic_pool', subnetId, ip,
        `${dnsLabel(record)} assigns IP ${ip}, which is also available from ${naturalList(matchingScopes.map(scopeLabel))}.`,
        `Move or disable the ${record.type} record for ${dnsHostname(record)}, or resize the listed DHCP scope so it no longer includes ${ip}.`,
        [dnsLabel(record), ...matchingScopes.map(scopeLabel)]
      );
    }
    if (facts.protectedKind(subnetId, ip)
        && !canNameProtectedAddress(facts, subnetId, ip)) {
      const protectedKind = facts.protectedKind(subnetId, ip);
      addIssue(
        'protocol_claim_on_protected_address', subnetId, ip,
        `${dnsLabel(record)} assigns ${ip}, but ${ip} is the protected ${protectedKind} address on ${subnetLabel(record.subnet)}.`,
        `Move or disable the ${record.type} record for ${dnsHostname(record)}. Protected ${protectedKind} addresses cannot be assigned to a host.`,
        [dnsLabel(record), `${protectedKind} address ${ip}`]
      );
    }
    if (!canNameProtectedAddress(facts, subnetId, ip)
        && facts.reservationByKey.has(key)) {
      const reservation = facts.reservationByKey.get(key);
      addIssue(
        'competing_dns_and_dhcp_reservation', subnetId, ip,
        `${dnsLabel(record)} and ${reservationLabel(reservation)} both assign IP ${ip}.`,
        `Choose which assignment owns ${ip}. Disable or move the ${record.type} record for ${dnsHostname(record)}, or disable or move ${reservationLabel(reservation)}.`,
        [dnsLabel(record), reservationLabel(reservation)]
      );
    } else if (!canNameProtectedAddress(facts, subnetId, ip)
        && facts.leaseByKey.has(key)) {
      const lease = facts.leaseByKey.get(key);
      addIssue(
        'competing_dns_and_dynamic_lease', subnetId, ip,
        `${dnsLabel(record)} and ${leaseLabel(lease)} both assign IP ${ip}.`,
        `Choose which assignment owns ${ip}. Disable or move the ${record.type} record for ${dnsHostname(record)}, or release ${leaseLabel(lease)}.`,
        [dnsLabel(record), leaseLabel(lease)]
      );
    }
  }

  for (const reservation of facts.reservations) {
    const kind = facts.protectedKind(reservation.subnet_id, reservation.ip_address);
    if (kind) {
      addIssue(
        'protocol_claim_on_protected_address', reservation.subnet_id, reservation.ip_address,
        `${reservationLabel(reservation)} assigns ${reservation.ip_address}, but that IP is the protected ${kind} address on ${subnetLabel(facts.subnetById.get(reservation.subnet_id))}.`,
        `Disable or move ${reservationLabel(reservation)}. Protected ${kind} addresses cannot be assigned to a host.`,
        [reservationLabel(reservation), `${kind} address ${reservation.ip_address}`]
      );
    }
  }

  for (const lease of facts.leases) {
    const key = identityKey(lease.subnet_id, lease.ip_address);
    const reservation = facts.reservationByKey.get(key);
    const kind = facts.protectedKind(lease.subnet_id, lease.ip_address);
    if (kind) {
      addIssue(
        'protocol_claim_on_protected_address', lease.subnet_id, lease.ip_address,
        `${leaseLabel(lease)} assigns ${lease.ip_address}, but that IP is the protected ${kind} address on ${subnetLabel(facts.subnetById.get(lease.subnet_id))}.`,
        `Release ${leaseLabel(lease)}, then correct the DHCP scope or reservation that allowed the protected address.`,
        [leaseLabel(lease), `${kind} address ${lease.ip_address}`]
      );
    }
    if (!reservation && !facts.inEnabledPool(lease.subnet_id, lease.ip_address)) {
      addIssue(
        'dynamic_lease_outside_enabled_pool', lease.subnet_id, lease.ip_address,
        `${leaseLabel(lease)} assigns ${lease.ip_address}, but that IP is outside every enabled DHCP scope on ${subnetLabel(facts.subnetById.get(lease.subnet_id))}.`,
        `Release ${leaseLabel(lease)}, or enable or resize a DHCP scope so it includes ${lease.ip_address}.`,
        [leaseLabel(lease)]
      );
    }
    if (reservation
        && String(reservation.mac_address).toLowerCase() !== String(lease.mac_address).toLowerCase()) {
      addIssue(
        'reservation_lease_client_mismatch', lease.subnet_id, lease.ip_address,
        `${reservationLabel(reservation)} and ${leaseLabel(lease)} both use IP ${lease.ip_address}, but their MAC addresses do not match.`,
        `Correct ${reservationLabel(reservation)} to match the intended client, or release ${leaseLabel(lease)}.`,
        [reservationLabel(reservation), leaseLabel(lease)]
      );
    }
  }

  for (const row of facts.ips) {
    const key = identityKey(row.subnet_id, row.ip_address);
    if (row.status === 'locked' && !facts.protectedKind(row.subnet_id, row.ip_address)
        && (facts.dnsByKey.has(key) || facts.reservationByKey.has(key) || facts.leaseByKey.has(key))) {
      const protocolClaims = [
        ...(facts.dnsByKey.get(key) || []).map(dnsLabel),
        facts.reservationByKey.has(key) ? reservationLabel(facts.reservationByKey.get(key)) : null,
        facts.leaseByKey.has(key) ? leaseLabel(facts.leaseByKey.get(key)) : null
      ].filter(Boolean);
      addIssue(
        'locked_address_with_protocol_claim', row.subnet_id, row.ip_address,
        `IP ${row.ip_address} is manually reserved in Networks and is also claimed by ${naturalList(protocolClaims)}.`,
        `Choose which assignment owns ${row.ip_address}. Release the manual Networks reservation, or disable or remove ${naturalList(protocolClaims)}.`,
        [`Networks reservation for ${row.ip_address}`, ...protocolClaims]
      );
    }
    if (isLinkLocalV6(row.ip_address) && !row.interface_id) {
      addIssue(
        'unscoped_ipv6_link_local', row.subnet_id, row.ip_address,
        `Stored IPv6 link-local address ${row.ip_address} (IP row ${row.id}) has no interface, so it cannot be identified safely.`,
        `Remove the stale ${row.ip_address} entry before retrying. If the address is active, allow CIDRella to rediscover it with the correct interface after the upgrade.`,
        [`IP row ${row.id} for ${row.ip_address}`]
      );
    }
  }

  for (const [key, rows] of facts.ipByKey) {
    if (rows.length <= 1) continue;
    const [subnetId] = key.split('|');
    const rowLabels = rows.map(row => `IP row ${row.id} stored as ${row.ip_address}`);
    addIssue(
      'duplicate_canonical_identity', Number(subnetId), rows[0].ip_address,
      `${naturalList(rowLabels)} all represent the same canonical IP ${canonicalizeIp(rows[0].ip_address) || rows[0].ip_address}.`,
      `Keep the row that represents the current host and remove the duplicate historical rows before retrying. Preserve any hostname, MAC address, or notes that still belong to the current host.`,
      rowLabels
    );
  }

  const assignedWithoutManualDns = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ip_addresses ip
    WHERE ip.status = 'assigned'
      AND NOT EXISTS (
        SELECT 1 FROM dns_records record
        JOIN dns_zones zone ON zone.id = record.zone_id
        WHERE record.value = ip.ip_address
          AND record.type IN ('A', 'AAAA')
          AND record.enabled = 1 AND zone.enabled = 1
          AND zone.type = 'forward'
          AND COALESCE(record.source, 'manual') = 'manual'
      )
  `).get().count;
  const unbackedDhcp = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ip_addresses ip
    WHERE ip.status = 'dhcp'
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_reservations reservation
        WHERE reservation.subnet_id = ip.subnet_id
          AND reservation.ip_address = ip.ip_address AND reservation.enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_leases lease
        WHERE lease.subnet_id = ip.subnet_id AND lease.ip_address = ip.ip_address
          AND (lease.expires_at = 'infinite' OR datetime(lease.expires_at) > datetime('now'))
      )
  `).get().count;

  const disabledDnsLooksActive = db.prepare(`
    SELECT COUNT(DISTINCT ip.id) AS count
    FROM ip_addresses ip
    JOIN dns_records record ON record.value = ip.ip_address
    JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE ip.status = 'assigned'
      AND (record.enabled = 0 OR zone.enabled = 0)
      AND record.type IN ('A', 'AAAA')
      AND COALESCE(record.source, 'manual') = 'manual'
      AND NOT EXISTS (
        SELECT 1 FROM dns_records enabled_record
        JOIN dns_zones enabled_zone ON enabled_zone.id = enabled_record.zone_id
        WHERE enabled_record.value = ip.ip_address
          AND enabled_record.type IN ('A', 'AAAA')
          AND enabled_record.enabled = 1 AND enabled_zone.enabled = 1
          AND enabled_zone.type = 'forward'
          AND COALESCE(enabled_record.source, 'manual') = 'manual'
      )
  `).get().count;
  const disabledReservationLooksActive = db.prepare(`
    SELECT COUNT(DISTINCT ip.id) AS count
    FROM ip_addresses ip
    JOIN dhcp_reservations reservation
      ON reservation.subnet_id = ip.subnet_id
     AND reservation.ip_address = ip.ip_address
    WHERE ip.status = 'dhcp' AND reservation.enabled = 0
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_reservations enabled_reservation
        WHERE enabled_reservation.subnet_id = ip.subnet_id
          AND enabled_reservation.ip_address = ip.ip_address
          AND enabled_reservation.enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_leases lease
        WHERE lease.subnet_id = ip.subnet_id AND lease.ip_address = ip.ip_address
          AND (lease.expires_at = 'infinite' OR datetime(lease.expires_at) > datetime('now'))
      )
  `).get().count;

  const claimKeys = new Set([
    ...facts.ipByKey.keys(), ...facts.reservationByKey.keys(),
    ...facts.leaseByKey.keys(), ...facts.dnsByKey.keys()
  ]);
  let multipleClaims = 0;
  for (const key of claimKeys) {
    const rows = facts.ipByKey.get(key) || [];
    const row = rows[0];
    const [subnetText, ip] = key.split('|');
    const subnetId = Number(subnetText);
    const claims = new Set();
    if (facts.protectedKind(subnetId, ip)) claims.add('topology');
    if (row?.status === 'locked' && !facts.protectedKind(subnetId, ip)) claims.add('admin_reservation');
    if (facts.dnsByKey.has(key) && !canNameProtectedAddress(facts, subnetId, ip)) {
      claims.add('dns');
    }
    if ((facts.dnsByKey.get(key)?.length || 0) > 1) claims.add('duplicate_dns_claim');
    if (facts.reservationByKey.has(key)) claims.add('dhcp_reservation');
    else if (facts.leaseByKey.has(key)) claims.add('dhcp_lease');
    if (claims.size > 1) multipleClaims++;
  }

  const canonicalIpSubnets = new Map();
  for (const row of facts.ips) {
    const canonical = canonicalizeIp(row.ip_address) || row.ip_address;
    if (!canonicalIpSubnets.has(canonical)) canonicalIpSubnets.set(canonical, new Set());
    canonicalIpSubnets.get(canonical).add(row.subnet_id);
  }
  const hostnameMatches = (left, right) => {
    const a = String(left || '').trim().toLowerCase().replace(/\.$/, '');
    const b = String(right || '').trim().toLowerCase().replace(/\.$/, '');
    return !a || !b || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
  };
  let hostnameDisagreements = 0;
  let macDisagreements = 0;
  for (const row of facts.ips) {
    const key = identityKey(row.subnet_id, row.ip_address);
    const expectedNames = [
      facts.reservationByKey.get(key)?.hostname,
      facts.leaseByKey.get(key)?.hostname,
      ...(facts.dnsByKey.get(key) || []).map(record => (
        record.name === '@' ? record.zone_name : `${record.name}.${record.zone_name}`
      ))
    ].filter(Boolean);
    if (row.hostname && expectedNames.length
        && !expectedNames.some(name => hostnameMatches(row.hostname, name))) hostnameDisagreements++;
    const expectedMacs = [
      facts.reservationByKey.get(key)?.mac_address,
      facts.leaseByKey.get(key)?.mac_address
    ].filter(Boolean).map(mac => String(mac).toLowerCase());
    if (row.mac_address && expectedMacs.length
        && !expectedMacs.includes(String(row.mac_address).toLowerCase())) macDisagreements++;
  }

  return {
    generated_at: new Date().toISOString(),
    policy: 'block',
    summary: {
      ip_addresses: facts.ips.length,
      enabled_manual_dns_claims: facts.dns.length,
      ips_with_multiple_static_dns_names: [...facts.dnsByKey.values()]
        .filter(records => records.length > 1).length,
      enabled_dhcp_reservations: facts.reservations.length,
      active_dhcp_leases: facts.leases.length,
      blocking_conflicts: issues.size,
      ips_with_multiple_enabled_claims: multipleClaims,
      manual_dns_inside_enabled_pool: facts.dns.filter(record => (
        facts.inEnabledPool(record.subnet.id, record.ip_address)
      )).length,
      protocol_claims_on_protected_addresses: [...claimKeys].filter(key => {
        const [subnetText, ip] = key.split('|');
        const subnetId = Number(subnetText);
        return facts.protectedKind(subnetId, ip)
          && ((facts.dnsByKey.has(key) && !canNameProtectedAddress(facts, subnetId, ip))
            || facts.reservationByKey.has(key) || facts.leaseByKey.has(key));
      }).length,
      locked_addresses_inside_enabled_pool: facts.ips.filter(row => (
        row.status === 'locked' && facts.inEnabledPool(row.subnet_id, row.ip_address)
      )).length,
      dynamic_leases_outside_enabled_pool: facts.leases.filter(lease => {
        const key = identityKey(lease.subnet_id, lease.ip_address);
        return !facts.reservationByKey.has(key)
          && !facts.inEnabledPool(lease.subnet_id, lease.ip_address);
      }).length,
      disabled_configuration_active_looking: disabledDnsLooksActive + disabledReservationLooksActive,
      safe_assigned_rows_without_manual_dns: assignedWithoutManualDns,
      safe_dhcp_rows_without_active_backing: unbackedDhcp,
      allocated_rows_marked_rogue: facts.ips.filter(row => {
        const key = identityKey(row.subnet_id, row.ip_address);
        return row.is_rogue === 1 && (row.status === 'locked' || row.status === 'assigned'
          || facts.reservationByKey.has(key) || facts.leaseByKey.has(key) || facts.dnsByKey.has(key));
      }).length,
      duplicate_canonical_identity_groups: [...facts.ipByKey.values()].filter(rows => rows.length > 1).length,
      duplicate_ip_rows_across_subnets: [...canonicalIpSubnets.values()].filter(ids => ids.size > 1).length,
      noncanonical_address_rows: facts.ips.filter(row => canonicalizeIp(row.ip_address) !== row.ip_address).length,
      ipv4_mapped_address_rows: facts.ips.filter(row => row.ip_address.toLowerCase().includes('::ffff:')).length,
      unscoped_ipv6_link_local_rows: facts.ips.filter(row => (
        isLinkLocalV6(row.ip_address) && !row.interface_id
      )).length,
      hostname_disagreements: hostnameDisagreements,
      mac_disagreements: macDisagreements
    },
    conflicts: [...issues.values()].sort((left, right) => (
      left.category.localeCompare(right.category)
      || left.subnet_id - right.subnet_id
      || left.ip_address.localeCompare(right.ip_address)
    ))
  };
}

export function reconcileMigratedIpLifecycle(db, options = {}) {
  const facts = loadFacts(db, options);
  const candidates = new Map();
  const add = (subnetId, ip, existing = null) => {
    const canonical = canonicalizeIp(ip);
    if (!canonical) return;
    const key = identityKey(subnetId, canonical);
    if (!candidates.has(key)) candidates.set(key, { subnetId, ip: canonical, existing });
    else if (existing) candidates.get(key).existing = existing;
  };
  for (const row of facts.ips) add(row.subnet_id, row.ip_address, row);
  for (const row of facts.reservations) add(row.subnet_id, row.ip_address);
  for (const row of facts.leases) add(row.subnet_id, row.ip_address);
  for (const row of facts.dns) add(row.subnet.id, row.ip_address);
  for (const subnet of facts.subnets.filter(row => row.status === 'allocated')) {
    add(subnet.id, subnet.network_address);
    add(subnet.id, subnet.broadcast_address);
    add(subnet.id, subnet.gateway_address);
  }
  for (const ip of facts.localAddresses) {
    const subnet = bestSubnet(facts.subnets, ip);
    if (subnet) add(subnet.id, ip);
  }

  const rows = [];
  for (const candidate of candidates.values()) {
      const key = identityKey(candidate.subnetId, candidate.ip);
      const existing = candidate.existing;
      const protectedState = facts.protectedKind(candidate.subnetId, candidate.ip);
      const reservation = facts.reservationByKey.get(key);
      const records = facts.dnsByKey.get(key);
      const lease = facts.leaseByKey.get(key);
      let state = protectedState || 'unassigned';
      let sourceType = protectedState ? 'topology' : null;
      let sourceId = protectedState ? candidate.subnetId : null;
      let dhcpVersion = null;
      let note = protectedState ? `Protected ${protectedState} address` : null;
      if (!protectedState && reservation) {
        state = 'static_dhcp'; sourceType = 'dhcp_reservation'; sourceId = reservation.id; dhcpVersion = 4;
      } else if (!protectedState && records?.length) {
        state = 'static_dns'; sourceType = 'dns'; sourceId = records[0].id;
      } else if (!protectedState && lease) {
        state = 'dynamic_dhcp'; sourceType = 'dhcp_lease'; sourceId = lease.id; dhcpVersion = 4;
      } else if (!protectedState && existing?.allocation_state === 'reserved') {
        state = 'reserved'; sourceType = 'admin_reservation';
        note = existing.reservation_note || null;
      }
      rows.push({
        subnetId: candidate.subnetId,
        ip: candidate.ip,
        state,
        sourceType,
        sourceId,
        dhcpVersion,
        note
      });
  }
  return writeMigratedIpLifecycleRows(db, rows);
}

export function writeLifecycleMigrationReport(dataDir, report) {
  const destination = path.join(dataDir, LIFECYCLE_MIGRATION_REPORT);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

export function readLifecycleMigrationReport(dataDir) {
  const source = path.join(dataDir, LIFECYCLE_MIGRATION_REPORT);
  try {
    const report = JSON.parse(fs.readFileSync(source, 'utf8'));
    return report && typeof report === 'object' ? report : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    console.warn(`Unable to read IP lifecycle migration report ${source}: ${err.message}`);
    return { outcome: 'invalid' };
  }
}

export function hasLegacyIpLifecycleTables(db) {
  return tableExists(db, 'ip_addresses')
    && tableExists(db, 'dhcp_reservations')
    && tableExists(db, 'dhcp_leases')
    && tableExists(db, 'dns_records')
    && tableExists(db, 'dns_zones')
    && tableExists(db, 'dhcp_scopes')
    && tableExists(db, 'ranges')
    && columnExists(db, 'ip_addresses', 'status');
}
