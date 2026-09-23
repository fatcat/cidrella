import { EMPTY_CELL } from './format.js';

const SOURCE_LABELS = Object.freeze({
  dns: 'Static DNS',
  dns_record: 'Static DNS',
  dhcp: 'DHCP lease',
  dhcp_lease: 'DHCP lease',
  reservation: 'DHCP Reservation',
  dhcp_reservation: 'DHCP Reservation',
  placeholder: 'Placeholder',
  scanner: 'Scanner',
  passive: 'Passive DNS',
  neighbor_discovery: 'Neighbor discovery',
  interface: 'Interface',
  slaac: 'SLAAC',
  manual: 'Manual',
});

function sourceLabel(source) {
  if (!source) return EMPTY_CELL;
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  return String(source)
    .replaceAll('_', ' ')
    .replace(/^./, (first) => first.toUpperCase());
}

/** What gave the address its allocation, or how CIDRella found it. */
export function allocationSourceLabel(row) {
  // An address a disabled record holds (ADR 004) is not static DNS: the name
  // does not resolve.
  if (row?.allocation_state === 'reserved' && row.allocation_source_type === 'dns')
    return 'Disabled DNS record';
  return sourceLabel(row?.allocation_source_type || row?.detection_source);
}

/** What wrote a DNS record: manual, DHCP, a reservation, a placeholder. */
export function recordSourceLabel(row) {
  return sourceLabel(row?.dns_source);
}

/** A DNS row's record source, any other row's allocation source. */
export function ipSourceLabel(row) {
  return row?.dns_source ? recordSourceLabel(row) : allocationSourceLabel(row);
}

export function dhcpLeaseDisplay(status) {
  if (status === 'active') return { label: 'Active', className: 'state-ok' };
  if (status === 'available') return { label: 'Available', className: 'state-muted' };
  if (status === 'unavailable') return { label: 'Unavailable', className: 'state-err' };
  if (status === 'expired' || status === 'offline')
    return { label: 'Inactive', className: 'state-muted' };
  return null;
}
