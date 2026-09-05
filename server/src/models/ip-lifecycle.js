/**
 * Canonical IP lifecycle vocabulary and transition contract.
 *
 * Allocation is mutually exclusive. Liveness, dynamic-pool membership, and
 * protocol details are independent facts and must not be encoded as an
 * allocation state.
 */

export const ALLOCATION_STATE = Object.freeze({
  UNASSIGNED: 'unassigned',
  RESERVED: 'reserved',
  STATIC_DNS: 'static_dns',
  DYNAMIC_DHCP: 'dynamic_dhcp',
  STATIC_DHCP: 'static_dhcp',
  SLAAC: 'slaac',
  SYSTEM: 'system',
  GATEWAY: 'gateway',
  QUARANTINED: 'quarantined'
});

export const DISPLAY_STATUS = Object.freeze({
  AVAILABLE: 'available',
  DHCP_SCOPE: 'DHCP Scope',
  IN_USE: 'in use'
});

export const ADDRESS_FAMILY = Object.freeze({
  IPV4: 4,
  IPV6: 6
});

export const LIFECYCLE_SOURCE = Object.freeze({
  ADMIN_RESERVATION: 'admin_reservation',
  DNS: 'dns',
  DHCP_RESERVATION: 'dhcp_reservation',
  DHCP_LEASE: 'dhcp_lease',
  SLAAC: 'slaac',
  TOPOLOGY: 'topology',
  RECONCILIATION: 'reconciliation'
});

const A = ALLOCATION_STATE;
const S = LIFECYCLE_SOURCE;

/**
 * Allowed allocation-state transitions grouped by authoritative source.
 * Same-state writes are renewals or metadata updates and are allowed only for
 * the source that owns that state.
 */
export const ALLOCATION_TRANSITIONS = Object.freeze({
  [S.ADMIN_RESERVATION]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.RESERVED]),
    [A.RESERVED]: Object.freeze([A.RESERVED, A.UNASSIGNED])
  }),
  [S.DNS]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.STATIC_DNS]),
    [A.RESERVED]: Object.freeze([A.STATIC_DNS]),
    [A.STATIC_DNS]: Object.freeze([A.STATIC_DNS, A.UNASSIGNED])
  }),
  [S.DHCP_RESERVATION]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.STATIC_DHCP]),
    [A.RESERVED]: Object.freeze([A.STATIC_DHCP]),
    [A.STATIC_DHCP]: Object.freeze([A.STATIC_DHCP, A.UNASSIGNED])
  }),
  [S.DHCP_LEASE]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.DYNAMIC_DHCP]),
    [A.DYNAMIC_DHCP]: Object.freeze([A.DYNAMIC_DHCP, A.UNASSIGNED])
  }),
  [S.SLAAC]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.SLAAC]),
    [A.SLAAC]: Object.freeze([A.SLAAC, A.UNASSIGNED])
  }),
  [S.TOPOLOGY]: Object.freeze({
    [A.UNASSIGNED]: Object.freeze([A.SYSTEM, A.GATEWAY]),
    [A.SYSTEM]: Object.freeze([A.SYSTEM, A.UNASSIGNED]),
    [A.GATEWAY]: Object.freeze([A.GATEWAY, A.UNASSIGNED])
  }),
  [S.RECONCILIATION]: Object.freeze(
    Object.fromEntries(Object.values(A).map(from => [from, Object.freeze(Object.values(A))]))
  )
});

export function canTransitionAllocation(from, to, source) {
  return ALLOCATION_TRANSITIONS[source]?.[from]?.includes(to) === true;
}

export function displayStatusFor({ allocationState, inDynamicPool = false }) {
  if (allocationState !== A.UNASSIGNED) return DISPLAY_STATUS.IN_USE;
  return inDynamicPool ? DISPLAY_STATUS.DHCP_SCOPE : DISPLAY_STATUS.AVAILABLE;
}

/**
 * Select the one canonical hostname without changing allocation authority.
 *
 * Protected topology addresses may be named by static DNS. Allocations owned
 * by DNS or DHCP accept only their owning protocol's name. States without a
 * protocol owner use the available learned name in deterministic order. That
 * final branch preserves DHCP names during the offline-retention window while
 * the address itself is already unassigned.
 */
export function canonicalHostnameForAllocation({
  allocationState,
  dnsHostname = null,
  reservationHostname = null,
  leaseHostname = null
}) {
  if ([A.STATIC_DNS, A.SYSTEM, A.GATEWAY].includes(allocationState)) {
    return dnsHostname ? { hostname: dnsHostname, source: S.DNS } : { hostname: null, source: null };
  }
  if (allocationState === A.STATIC_DHCP) {
    return reservationHostname
      ? { hostname: reservationHostname, source: S.DHCP_RESERVATION }
      : { hostname: null, source: null };
  }
  if (allocationState === A.DYNAMIC_DHCP) {
    return leaseHostname
      ? { hostname: leaseHostname, source: S.DHCP_LEASE }
      : { hostname: null, source: null };
  }
  if (dnsHostname) return { hostname: dnsHostname, source: S.DNS };
  if (reservationHostname) return { hostname: reservationHostname, source: S.DHCP_RESERVATION };
  if (leaseHostname) return { hostname: leaseHostname, source: S.DHCP_LEASE };
  return { hostname: null, source: null };
}
