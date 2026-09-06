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
  manual: 'Manual'
});

export function ipSourceLabel(row) {
  const source = row?.dns_source || row?.allocation_source_type || row?.detection_source;
  if (!source) return EMPTY_CELL;
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  return String(source).replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
}

export function dhcpLeaseDisplay(status) {
  if (status === 'active') return { label: 'Active', className: 'state-ok' };
  if (status === 'available') return { label: 'Available', className: 'state-muted' };
  if (status === 'unavailable') return { label: 'Unavailable', className: 'state-err' };
  if (status === 'expired' || status === 'offline') return { label: 'Inactive', className: 'state-muted' };
  return null;
}
