import { lookupVendorBatch } from '../utils/mac-vendor.js';
import { localIpv4Set } from '../utils/local-addresses.js';
import { lookupFingerprintBatch } from './device-fingerprint.js';
import * as DnsRecord from './dns-record.js';

export const ADDRESS_TYPE = {
  STATIC_DNS: 'static DNS',
  DYNAMIC_DHCP: 'dynamic DHCP',
  RESERVED_DHCP: 'reserved DHCP',
  SYSTEM: 'system',
  GATEWAY: 'gateway',
  LOCKED: 'locked',
  ROGUE: 'rogue'
};

function truthy(value) {
  return value === true || value === 1 || value === '1';
}

function activeLease(expiresAt) {
  if (!expiresAt) return false;
  if (expiresAt === 'infinite') return true;
  return new Date(expiresAt) >= new Date();
}

export function computeIpView(row) {
  const ipLifecycleStatus = row.ip_lifecycle_status || row.status || 'available';
  const hasActiveLease = activeLease(row.dhcp_expires_at);
  const hasDhcpReservation = truthy(row.has_dhcp_reservation);
  const hasStaticDns = truthy(row.has_static_dns);
  const isOnline = truthy(row.is_online);
  const isRogue = truthy(row.is_rogue);
  const isStaticDns = hasStaticDns || (row.detection_source === 'dns' && !!row.hostname);

  let addressType = null;
  let displayStatus = 'available';
  let statusSeverity = 'secondary';
  let tooltip = null;

  if (row.range_type_name === 'Network' || row.range_type_name === 'Broadcast') {
    addressType = ADDRESS_TYPE.SYSTEM;
  } else if (row.range_type_name === 'Gateway') {
    addressType = ADDRESS_TYPE.GATEWAY;
  } else if (truthy(row.is_local_address)) {
    // An address the appliance itself holds. Ahead of the isRogue branch on
    // purpose, so a row mislabelled by the old behaviour reads correctly
    // straight away rather than waiting for the next scan to clear the flag.
    addressType = ADDRESS_TYPE.SYSTEM;
    tooltip = 'This CIDRella interface';
  } else if (isRogue) {
    addressType = ADDRESS_TYPE.ROGUE;
    tooltip = row.rogue_reason || null;
  } else if (isOnline && ipLifecycleStatus === 'available' && !hasDhcpReservation && !row.hostname && !hasActiveLease && !hasStaticDns) {
    addressType = ADDRESS_TYPE.ROGUE;
  } else if (hasDhcpReservation) {
    addressType = ADDRESS_TYPE.RESERVED_DHCP;
  } else if (hasActiveLease) {
    addressType = ADDRESS_TYPE.DYNAMIC_DHCP;
  } else if (ipLifecycleStatus === 'locked') {
    addressType = ADDRESS_TYPE.LOCKED;
    tooltip = row.reservation_note || null;
  } else if (ipLifecycleStatus === 'assigned' || isStaticDns) {
    addressType = ADDRESS_TYPE.STATIC_DNS;
  } else if (isOnline && (ipLifecycleStatus === 'available' || ipLifecycleStatus === 'dhcp')) {
    // No hasStaticDns guard needed here: the isStaticDns branch directly above
    // already claimed every such row. The guard belongs on the earlier
    // available-and-online branch, which runs BEFORE that claim and was
    // therefore labelling DNS-named hosts rogue on sight.
    addressType = ADDRESS_TYPE.ROGUE;
  }

  if (addressType) {
    displayStatus = 'in use';
    statusSeverity = 'danger';
  }

  return {
    ip_lifecycle_status: ipLifecycleStatus,
    ip_display_status: displayStatus,
    ip_status_severity: statusSeverity,
    address_type: addressType,
    address_type_tooltip: tooltip
  };
}

export function applyIpView(row) {
  const view = computeIpView(row);
  Object.assign(row, view);
  row.computed_type = view.address_type || 'available';
  return row;
}

/**
 * Addresses claimed by a manual forward A record. Delegates to the single
 * definition in dns-record.js. The `ips` argument is accepted for call-site
 * compatibility but no longer needed to filter: the record set is bounded by
 * what the operator created, so one unchunked query beats N chunked ones.
 */
export function getStaticDnsIpSet(db, _ips) {
  return DnsRecord.dnsAssignedIpSet(db);
}

export function getIpStateMap(db, rows) {
  const addresses = [...new Set((rows || []).map(r => r.ip_address).filter(Boolean))];
  const map = new Map();
  const CHUNK_SIZE = 900;
  for (let i = 0; i < addresses.length; i += CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const stateRows = db.prepare(`
      SELECT subnet_id, ip_address, hostname, mac_address, last_seen_mac, status,
             is_online, is_rogue, rogue_reason, detection_source,
             last_seen_at, last_scanned_at, reservation_note, scan_enabled
        FROM ip_addresses
       WHERE ip_address IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk);
    for (const row of stateRows) {
      map.set(`${row.subnet_id}:${row.ip_address}`, row);
    }
  }
  return map;
}

export function enrichIpViewRows(db, rows, { fillFromIpAddress = false } = {}) {
  if (!rows?.length) return rows || [];

  const stateMap = fillFromIpAddress ? getIpStateMap(db, rows) : new Map();
  const staticDnsIps = getStaticDnsIpSet(db, rows.map(r => r.ip_address));
  const localIps = localIpv4Set();

  for (const row of rows) {
    const state = stateMap.get(`${row.subnet_id}:${row.ip_address}`);
    if (state) {
      row.ip_lifecycle_status = state.status || 'available';
      row.is_online = !!state.is_online;
      row.is_rogue = state.is_rogue || 0;
      row.rogue_reason = state.rogue_reason || null;
      row.detection_source = state.detection_source || null;
      row.last_seen_at = state.last_seen_at || null;
      row.last_scanned_at = state.last_scanned_at || null;
      row.reservation_note = state.reservation_note || null;
      row.scan_enabled = state.scan_enabled;
      if (!row.hostname && state.hostname) row.hostname = state.hostname;
      if (!row.mac_address && (state.mac_address || state.last_seen_mac)) {
        row.mac_address = state.mac_address || state.last_seen_mac;
      }
      if (!row.last_seen_mac && state.last_seen_mac) row.last_seen_mac = state.last_seen_mac;
    } else if (!row.ip_lifecycle_status) {
      row.ip_lifecycle_status = row.status || 'available';
    }

    if (row.has_static_dns === undefined) {
      row.has_static_dns = staticDnsIps.has(row.ip_address) ? 1 : 0;
    }
    if (row.is_local_address === undefined) {
      row.is_local_address = localIps.has(row.ip_address) ? 1 : 0;
    }
    applyIpView(row);
  }

  const allMacs = [...new Set(rows.map(r => r.mac_address || r.last_seen_mac).filter(Boolean))];
  const vendorMap = lookupVendorBatch(allMacs);
  const fpMap = lookupFingerprintBatch(db, allMacs);
  for (const row of rows) {
    const mac = row.mac_address || row.last_seen_mac;
    row.vendor = mac ? (vendorMap.get(mac) || null) : null;
    const fp = mac ? fpMap.get(mac) : null;
    row.device_type = fp?.device_type || null;
    row.os_family = fp?.os_family || null;
    row.device_confidence = fp?.confidence ?? null;
  }

  return rows;
}
