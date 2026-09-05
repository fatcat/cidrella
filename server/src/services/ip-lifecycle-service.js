/**
 * Application boundary for IP allocation and liveness changes.
 *
 * Protocol models and observation adapters call this service. The IP model is
 * the low-level repository, while ip-sync owns protocol metadata projection.
 */
import * as IpAddress from '../models/ip-address.js';
import * as IpSync from '../utils/ip-sync.js';
import {
  ALLOCATION_STATE,
  LIFECYCLE_SOURCE,
  canTransitionAllocation
} from '../models/ip-lifecycle.js';
import { findEnabledScopeForIp } from '../models/dhcp-scope.js';
import { isValidIpv4, parseCidr, ipToLong } from '../utils/ip.js';
import { isLocalAddress } from '../utils/local-addresses.js';
import { deleteDynamicDhcpRecordsByIps } from '../models/dns-record.js';
import { deleteLeasesByAddress, findLeasesByAddress } from '../models/dhcp-lease.js';
import { releaseDnsmasqLease } from '../utils/dhcp-release.js';
import { leaseExpiryMs } from '../utils/lease-sql.js';
import { parseIp } from '../utils/address.js';

export const OFFLINE_RETIREMENT_MS = 60 * 60 * 1000;

let lastRetirementDiagnostics = null;

export function getLastRetirementDiagnostics() {
  return lastRetirementDiagnostics ? structuredClone(lastRetirementDiagnostics) : null;
}

export class IpLifecycleConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IpLifecycleConflictError';
    this.code = 'IP_ALLOCATION_CONFLICT';
    this.status = 409;
    Object.assign(this, details);
  }
}

function protectedAddress(db, subnetId, ip) {
  if (!isValidIpv4(ip)) return null;
  const subnet = db.prepare(
    'SELECT cidr, gateway_address FROM subnets WHERE id = ?'
  ).get(subnetId);
  if (!subnet) {
    return {
      state: null,
      dnsNameAllowed: false,
      reason: 'Address does not belong to a managed subnet'
    };
  }
  const parsed = parseCidr(subnet.cidr);
  const value = ipToLong(ip);
  if (value === parsed.networkLong) {
    return {
      state: ALLOCATION_STATE.SYSTEM,
      dnsNameAllowed: false,
      reason: 'Network address is protected'
    };
  }
  if (value === parsed.broadcastLong) {
    return {
      state: ALLOCATION_STATE.SYSTEM,
      dnsNameAllowed: false,
      reason: 'Broadcast address is protected'
    };
  }
  if (subnet.gateway_address === ip) {
    return {
      state: ALLOCATION_STATE.GATEWAY,
      dnsNameAllowed: true,
      reason: 'Gateway address is protected'
    };
  }
  if (isLocalAddress(ip)) {
    return {
      state: ALLOCATION_STATE.SYSTEM,
      dnsNameAllowed: true,
      reason: 'CIDRella service address is protected'
    };
  }
  return null;
}

function protectedAddressReason(db, subnetId, ip) {
  return protectedAddress(db, subnetId, ip)?.reason || null;
}

function assertAllocationTransition(db, subnetId, ip, targetState, source) {
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, ip);
  const currentState = existing?.allocation_state || ALLOCATION_STATE.UNASSIGNED;
  const topologyTarget = targetState === ALLOCATION_STATE.SYSTEM
    || targetState === ALLOCATION_STATE.GATEWAY;
  if (targetState !== ALLOCATION_STATE.UNASSIGNED && !topologyTarget) {
    const protectedReason = protectedAddressReason(db, subnetId, ip);
    if (protectedReason) {
      throw new IpLifecycleConflictError(protectedReason, { currentState, targetState, ip });
    }
  }
  if (currentState === ALLOCATION_STATE.UNASSIGNED && targetState === ALLOCATION_STATE.UNASSIGNED) {
    return existing;
  }
  if (!canTransitionAllocation(currentState, targetState, source)) {
    throw new IpLifecycleConflictError(
      `Cannot change ${ip} from ${currentState} to ${targetState} via ${source}`,
      { currentState, targetState, ip }
    );
  }
  return existing;
}

function setCanonicalAllocation(db, subnetId, ip, state, sourceType, sourceId = null, fields = {}) {
  const allocationFields = state === ALLOCATION_STATE.UNASSIGNED
    ? {
        preferred_until: null,
        valid_until: null,
        dhcp_version: null,
        dhcp_duid: null,
        dhcp_iaid: null
      }
    : { is_rogue: 0, rogue_reason: null };
  return IpAddress.upsert(db, subnetId, ip, {
    ...allocationFields,
    ...fields,
    allocation_state: state,
    allocation_source_type: sourceType,
    allocation_source_id: sourceId
  });
}

function lifecycleIdentityIp(ip, interfaceId) {
  const parsed = parseIp(ip);
  if (!parsed) throw new Error(`Invalid IP address: ${ip}`);
  const linkLocal = parsed.bits === 128
    && parsed.value >= 0xfe800000000000000000000000000000n
    && parsed.value <= 0xfebfffffffffffffffffffffffffffffn;
  if (!linkLocal || parsed.zoneId || !interfaceId) return ip;
  return `${ip}%${interfaceId}`;
}

export function allocateStaticDns(db, recordName, ip, zoneName, recordId = null) {
  const subnet = IpSync.findSubnetForIp(db, ip);
  if (!subnet) return null;
  const existing = IpAddress.findBySubnetAndIp(db, subnet.id, ip);
  const scope = findEnabledScopeForIp(db, subnet.id, ip);
  if (scope) {
    throw new IpLifecycleConflictError(
      `Cannot allocate ${ip} through DNS because it is inside enabled DHCP scope ${scope.id}`,
      {
        currentState: existing?.allocation_state || ALLOCATION_STATE.UNASSIGNED,
        targetState: ALLOCATION_STATE.STATIC_DNS,
        ip,
        scopeId: scope.id
      }
    );
  }
  const protectedTarget = protectedAddress(db, subnet.id, ip);
  if (protectedTarget?.dnsNameAllowed) {
    protectTopologyAddress(
      db, subnet.id, ip, protectedTarget.state,
      existing?.reservation_note || `Protected ${protectedTarget.state} address`
    );
    IpSync.syncDnsToIp(db, recordName, ip, zoneName);
    // DNS supplies the display name, not allocation authority. Keep topology
    // as the protected row's detection source and canonical owner.
    IpAddress.upsert(db, subnet.id, ip, { detection_source: 'topology' });
    return IpAddress.findBySubnetAndIp(db, subnet.id, ip);
  }
  assertAllocationTransition(db, subnet.id, ip, ALLOCATION_STATE.STATIC_DNS, LIFECYCLE_SOURCE.DNS);
  IpSync.syncDnsToIp(db, recordName, ip, zoneName);
  return setCanonicalAllocation(
    db, subnet.id, ip, ALLOCATION_STATE.STATIC_DNS, LIFECYCLE_SOURCE.DNS, recordId
  );
}

export function deallocateStaticDns(db, recordName, ip, zoneName) {
  const subnet = IpSync.findSubnetForIp(db, ip);
  if (!subnet) return null;
  const existing = IpAddress.findBySubnetAndIp(db, subnet.id, ip);
  if ([ALLOCATION_STATE.SYSTEM, ALLOCATION_STATE.GATEWAY]
    .includes(existing?.allocation_state)) {
    IpSync.clearDnsFromIp(db, recordName, ip, zoneName);
    IpAddress.upsert(db, subnet.id, ip, { detection_source: 'topology' });
    return IpAddress.findBySubnetAndIp(db, subnet.id, ip);
  }
  assertAllocationTransition(db, subnet.id, ip, ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.DNS);
  IpSync.clearDnsFromIp(db, recordName, ip, zoneName);
  return setCanonicalAllocation(
    db, subnet.id, ip, ALLOCATION_STATE.UNASSIGNED, null, null
  );
}

export function reconcileStaticDnsZone(db, previousZone, currentZone = null, records = null) {
  const addressRecords = records || db.prepare(`
    SELECT id, name, value
    FROM dns_records
    WHERE zone_id = ?
      AND type = 'A'
      AND enabled = 1
      AND COALESCE(source, 'manual') = 'manual'
  `).all(previousZone.id);

  for (const record of addressRecords) {
    if (previousZone.type === 'forward' && previousZone.enabled) {
      deallocateStaticDns(db, record.name, record.value, previousZone.name);
    }
    if (currentZone?.type === 'forward' && currentZone.enabled) {
      allocateStaticDns(db, record.name, record.value, currentZone.name, record.id);
    }
  }
}

export function allocateStaticDhcp(db, subnetId, ip, fields = {}, reservationId = null) {
  assertAllocationTransition(
    db, subnetId, ip, ALLOCATION_STATE.STATIC_DHCP, LIFECYCLE_SOURCE.DHCP_RESERVATION
  );
  IpSync.syncDhcpReservationToIp(db, subnetId, ip, fields);
  return setCanonicalAllocation(
    db, subnetId, ip, ALLOCATION_STATE.STATIC_DHCP,
    LIFECYCLE_SOURCE.DHCP_RESERVATION, reservationId,
    { dhcp_version: fields.dhcp_version || 4, dhcp_duid: null, dhcp_iaid: null }
  );
}

export function deallocateStaticDhcp(db, subnetId, ip, macAddress) {
  assertAllocationTransition(
    db, subnetId, ip, ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.DHCP_RESERVATION
  );
  IpSync.clearDhcpReservationFromIp(db, subnetId, ip, macAddress);
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, ip);
  if (!existing) return null;
  const state = existing.detection_source === 'dhcp_lease'
    ? ALLOCATION_STATE.DYNAMIC_DHCP
    : ALLOCATION_STATE.UNASSIGNED;
  return setCanonicalAllocation(
    db, subnetId, ip, state,
    state === ALLOCATION_STATE.DYNAMIC_DHCP ? LIFECYCLE_SOURCE.DHCP_LEASE : null
  );
}

export function observeDhcpLeases(db, leases, { prevalidated = false } = {}) {
  if (!prevalidated) {
    for (const lease of leases) {
      if (!lease.subnetId) continue;
      const rejection = dhcpLeaseRejectionReason(db, lease);
      if (rejection) throw new IpLifecycleConflictError(rejection, { ip: lease.ip });
    }
  }
  IpSync.syncLeasesToIps(db, leases);
  for (const lease of leases) {
    if (!lease.subnetId) continue;
    const reservation = db.prepare(`
      SELECT id FROM dhcp_reservations
      WHERE subnet_id = ? AND ip_address = ? AND enabled = 1
    `).get(lease.subnetId, lease.ip);
    if (reservation) {
      setCanonicalAllocation(
        db, lease.subnetId, lease.ip, ALLOCATION_STATE.STATIC_DHCP,
        LIFECYCLE_SOURCE.DHCP_RESERVATION, reservation.id,
        { dhcp_version: 4, dhcp_duid: null, dhcp_iaid: null }
      );
    } else {
      const leaseRow = db.prepare(`
        SELECT id FROM dhcp_leases
        WHERE subnet_id = ? AND ip_address = ?
        ORDER BY id DESC LIMIT 1
      `).get(lease.subnetId, lease.ip);
      setCanonicalAllocation(
        db, lease.subnetId, lease.ip, ALLOCATION_STATE.DYNAMIC_DHCP,
        LIFECYCLE_SOURCE.DHCP_LEASE, leaseRow?.id || null,
        { dhcp_version: 4, dhcp_duid: null, dhcp_iaid: null }
      );
    }
  }
  return reconcileExpiredDhcpAllocations(db);
}

export function dhcpLeaseRejectionReason(db, lease) {
  if (!lease?.subnetId) return `DHCP lease ${lease?.ip || ''} has no managed subnet`;
  if (!isValidIpv4(lease.ip)) return `DHCP lease address ${lease.ip || ''} is invalid`;
  const reservation = db.prepare(`
    SELECT id, mac_address FROM dhcp_reservations
    WHERE subnet_id = ? AND ip_address = ? AND enabled = 1
  `).get(lease.subnetId, lease.ip);
  if (reservation && String(reservation.mac_address).toLowerCase() !== String(lease.mac || '').toLowerCase()) {
    return `DHCP lease ${lease.ip} does not match its static reservation client`;
  }
  if (!reservation && !findEnabledScopeForIp(db, lease.subnetId, lease.ip)) {
    return `Dynamic lease ${lease.ip} is outside an enabled DHCP scope`;
  }

  const targetState = reservation ? ALLOCATION_STATE.STATIC_DHCP : ALLOCATION_STATE.DYNAMIC_DHCP;
  const source = reservation ? LIFECYCLE_SOURCE.DHCP_RESERVATION : LIFECYCLE_SOURCE.DHCP_LEASE;
  try {
    assertAllocationTransition(db, lease.subnetId, lease.ip, targetState, source);
  } catch (err) {
    if (err instanceof IpLifecycleConflictError) return err.message;
    throw err;
  }
  return null;
}

export function reconcileExpiredDhcpAllocations(db) {
  const expired = db.prepare(`
    SELECT ip.subnet_id, ip.ip_address
    FROM ip_addresses ip
    WHERE ip.allocation_state = ?
      AND ip.dhcp_version = 4
      AND NOT EXISTS (
        SELECT 1
        FROM dhcp_leases dl
        WHERE dl.subnet_id = ip.subnet_id
          AND dl.ip_address = ip.ip_address
          AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
      )
  `).all(ALLOCATION_STATE.DYNAMIC_DHCP);

  for (const row of expired) {
    assertAllocationTransition(
      db, row.subnet_id, row.ip_address, ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.DHCP_LEASE
    );
    setCanonicalAllocation(
      db, row.subnet_id, row.ip_address, ALLOCATION_STATE.UNASSIGNED, null, null
    );
  }
  return expired.length;
}

export function observePassiveActivity(db, subnetId, ip, options) {
  return IpAddress.recordPassiveActivity(db, subnetId, ip, options);
}

export function observeScanResult(db, subnetId, ip, result) {
  return IpAddress.updateFromScan(db, subnetId, ip, result);
}

export function reconcileScanRogues(db, subnetId, exceptIps) {
  return IpAddress.clearRogueForSubnet(db, subnetId, exceptIps);
}

export function markStalePassiveAddresses(db, staleMinutes) {
  return IpAddress.bulkMarkStale(db, staleMinutes);
}

export function retireStaleDynamicAddresses(db, {
  now = new Date(),
  limit = 500,
  releaseLease = releaseDnsmasqLease
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Invalid retirement clock');
  const nowIso = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - OFFLINE_RETIREMENT_MS).toISOString();
  const batchLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 500));
  let candidates = [];
  let dnsRecordsRemoved = 0;
  const leasesByAddress = new Map();
  const stickyRelease = { released: 0, skipped: 0, failed: 0 };

  db.transaction(() => {
    IpAddress.startMissingRetirementWindows(db, nowIso);
    candidates = IpAddress.findRetirementCandidates(db, cutoff, nowIso, batchLimit);
  })();

  // A live dnsmasq lease is external authority. Release it before clearing the
  // database so a missing utility or network error cannot let the next lease
  // sync resurrect metadata that CIDRella has already retired.
  const eligible = [];
  for (const row of candidates) {
    const key = `${row.subnet_id}|${row.ip_address}`;
    const leases = findLeasesByAddress(db, row.subnet_id, row.ip_address);
    leasesByAddress.set(key, leases);
    let releaseFailed = false;
    for (const lease of leases) {
      const rawExpiry = String(lease.expires_at || '');
      const parsedExpiry = leaseExpiryMs(rawExpiry);
      const isActive = rawExpiry === 'infinite'
        || !Number.isFinite(parsedExpiry)
        || parsedExpiry > nowDate.getTime();
      if (!isActive) continue;

      let result;
      try {
        result = releaseLease(lease);
      } catch (err) {
        result = { released: false, error: err?.message || String(err) };
      }
      if (result?.released) stickyRelease.released++;
      else if (result?.skipped) stickyRelease.skipped++;
      else stickyRelease.failed++;
      if (!result?.released) releaseFailed = true;
    }
    if (!releaseFailed) eligible.push(row);
  }

  db.transaction(() => {
    if (eligible.length === 0) return;

    for (const row of eligible) {
      const identityIp = row.interface_id
        ? `${row.ip_address}%${row.interface_id}`
        : row.ip_address;
      if (row.allocation_state === ALLOCATION_STATE.DYNAMIC_DHCP) {
        assertAllocationTransition(
          db, row.subnet_id, identityIp,
          ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.DHCP_LEASE
        );
      } else if (row.allocation_state === ALLOCATION_STATE.SLAAC) {
        assertAllocationTransition(
          db, row.subnet_id, identityIp,
          ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.SLAAC
        );
      }
      deleteLeasesByAddress(db, row.subnet_id, row.ip_address);
      IpAddress.retireLearnedMetadata(db, row);
    }
    dnsRecordsRemoved = deleteDynamicDhcpRecordsByIps(
      db, eligible
    );
  })();

  const result = {
    retired: eligible.length,
    deferred: candidates.length - eligible.length,
    dnsRecordsRemoved,
    leasesRemoved: eligible.reduce((count, row) => (
      count + (leasesByAddress.get(`${row.subnet_id}|${row.ip_address}`)?.length || 0)
    ), 0),
    stickyRelease
  };
  lastRetirementDiagnostics = { last_run_at: nowIso, ...result };
  return result;
}

export function pruneLifecycleEvents(db) {
  return IpAddress.pruneEvents(db);
}

export function setManualReservation(db, subnetId, ip, reserved, note = null) {
  assertAllocationTransition(
    db, subnetId, ip,
    reserved ? ALLOCATION_STATE.RESERVED : ALLOCATION_STATE.UNASSIGNED,
    LIFECYCLE_SOURCE.ADMIN_RESERVATION
  );
  return setCanonicalAllocation(
    db, subnetId, ip,
    reserved ? ALLOCATION_STATE.RESERVED : ALLOCATION_STATE.UNASSIGNED,
    reserved ? LIFECYCLE_SOURCE.ADMIN_RESERVATION : null,
    null,
    {
      reservation_note: reserved ? note : null,
      detection_source: reserved ? 'manual' : null
    }
  );
}

export function protectTopologyAddress(db, subnetId, ip, state, note = null) {
  if (![ALLOCATION_STATE.SYSTEM, ALLOCATION_STATE.GATEWAY].includes(state)) {
    throw new Error(`Invalid protected topology state: ${state}`);
  }
  assertAllocationTransition(db, subnetId, ip, state, LIFECYCLE_SOURCE.TOPOLOGY);
  return setCanonicalAllocation(
    db, subnetId, ip, state, LIFECYCLE_SOURCE.TOPOLOGY, null,
    { reservation_note: note, detection_source: 'topology' }
  );
}

export function releaseTopologyAddress(db, subnetId, ip) {
  assertAllocationTransition(
    db, subnetId, ip, ALLOCATION_STATE.UNASSIGNED, LIFECYCLE_SOURCE.TOPOLOGY
  );
  return setCanonicalAllocation(
    db, subnetId, ip, ALLOCATION_STATE.UNASSIGNED, null, null,
    { reservation_note: null, detection_source: null }
  );
}

function ensureLifecycleAddresses(db, subnetId, entries) {
  let changes = 0;
  for (const entry of entries) {
    if ([ALLOCATION_STATE.SYSTEM, ALLOCATION_STATE.GATEWAY].includes(entry.allocation_state)) {
      const existed = IpAddress.findBySubnetAndIp(db, subnetId, entry.ip);
      protectTopologyAddress(
        db, subnetId, entry.ip, entry.allocation_state || ALLOCATION_STATE.GATEWAY,
        entry.reservation_note || 'Protected topology address'
      );
      if (!existed) changes++;
    } else {
      changes += IpAddress.ensureAddress(db, subnetId, entry.ip, entry).changes || 0;
    }
  }
  return { changes };
}

export function observeSlaac(db, subnetId, ip, {
  interfaceId,
  preferredUntil,
  validUntil,
  temporary = false
}) {
  if (!validUntil) throw new Error('SLAAC valid lifetime is required');
  const identityIp = lifecycleIdentityIp(ip, interfaceId);
  assertAllocationTransition(
    db, subnetId, identityIp, ALLOCATION_STATE.SLAAC, LIFECYCLE_SOURCE.SLAAC
  );
  return setCanonicalAllocation(
    db, subnetId, identityIp, ALLOCATION_STATE.SLAAC, LIFECYCLE_SOURCE.SLAAC, null,
    {
      preferred_until: preferredUntil || null,
      valid_until: validUntil,
      detection_source: temporary ? 'slaac_privacy' : 'slaac'
    }
  );
}

export function observeDhcpv6Lease(db, subnetId, ip, {
  duid,
  iaid,
  preferredUntil,
  validUntil,
  poolValidated = false,
  observedActivity = true
} = {}) {
  const normalizedDuid = typeof duid === 'string' ? duid.trim() : '';
  const normalizedIaid = ['string', 'number'].includes(typeof iaid)
    ? String(iaid).trim()
    : '';
  if (!normalizedDuid || !normalizedIaid
      || normalizedDuid.length > 512 || normalizedIaid.length > 128) {
    throw new Error('DHCPv6 lease requires DUID and IAID identity');
  }
  if (!validUntil) throw new Error('DHCPv6 valid lifetime is required');
  if (poolValidated !== true) {
    throw new Error('DHCPv6 lease requires validated enabled-pool membership');
  }
  assertAllocationTransition(
    db, subnetId, ip, ALLOCATION_STATE.DYNAMIC_DHCP, LIFECYCLE_SOURCE.DHCP_LEASE
  );
  return setCanonicalAllocation(
    db, subnetId, ip, ALLOCATION_STATE.DYNAMIC_DHCP, LIFECYCLE_SOURCE.DHCP_LEASE,
    null,
    {
      dhcp_version: 6,
      dhcp_duid: normalizedDuid,
      dhcp_iaid: normalizedIaid,
      preferred_until: preferredUntil || null,
      valid_until: validUntil,
      is_online: observedActivity ? 1 : undefined,
      detection_source: 'dhcpv6_lease'
    }
  );
}

export function observeNeighbor(db, subnetId, ip, { interfaceId, mac } = {}) {
  const identityIp = lifecycleIdentityIp(ip, interfaceId);
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, identityIp);
  const isRogue = !existing || existing.allocation_state === ALLOCATION_STATE.UNASSIGNED;
  return IpAddress.upsert(db, subnetId, identityIp, {
    is_online: 1,
    last_seen_mac: mac || undefined,
    is_rogue: isRogue ? 1 : 0,
    rogue_reason: isRogue ? 'Neighbor Discovery from unassigned address' : null,
    detection_source: 'neighbor_discovery'
  });
}

export function observeRouterAdvertisement(db, subnetId, ip, { interfaceId, trusted = false } = {}) {
  if (!trusted) throw new Error('Untrusted Router Advertisement cannot set gateway authority');
  const identityIp = lifecycleIdentityIp(ip, interfaceId);
  assertAllocationTransition(
    db, subnetId, identityIp, ALLOCATION_STATE.GATEWAY, LIFECYCLE_SOURCE.TOPOLOGY
  );
  return setCanonicalAllocation(
    db, subnetId, identityIp, ALLOCATION_STATE.GATEWAY, LIFECYCLE_SOURCE.TOPOLOGY,
    null, { detection_source: 'router_advertisement' }
  );
}

export const lifecycleRepository = Object.freeze({
  findBySubnetAndIp: IpAddress.findBySubnetAndIp,
  getEvents: IpAddress.getEvents,
  setScanEnabled: IpAddress.setScanEnabled,
  moveToSubnet: IpAddress.moveToSubnet,
  deleteBySubnet: IpAddress.deleteBySubnet,
  deleteByIpAddress: IpAddress.deleteByIpAddress,
  ensureAddresses: ensureLifecycleAddresses
});
