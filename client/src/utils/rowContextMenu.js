import { isValidIpv4 } from './ip.js';

const MANAGED_DNS_SOURCE_LABELS = Object.freeze({
  dns: 'Managed by forward DNS record',
  dhcp: 'Managed by DHCP lease',
  reservation: 'Managed by DHCP Reservation',
  placeholder: 'Generated reverse DNS placeholder'
});

export function managedDnsRecordMenuItem(record) {
  const label = MANAGED_DNS_SOURCE_LABELS[record?.dns_source];
  if (!label) return null;

  return {
    label,
    icon: 'pi pi-lock',
    disabled: true
  };
}

export function isEditableDnsRecord(record) {
  return !!record && !MANAGED_DNS_SOURCE_LABELS[record.dns_source];
}

export function isEditableDhcpReservation(row) {
  return row?.dhcp_assignment_type === 'reserved';
}

export function canAddDhcpReservation(row) {
  return !!row?.ip_address && !isEditableDhcpReservation(row);
}

export function isImmutableNetworkAddress(row) {
  return row?.range_type_name === 'Network' || row?.range_type_name === 'Broadcast';
}

export function probeNowMenuItem(command) {
  return {
    label: 'Probe Now',
    icon: 'pi pi-wifi',
    command
  };
}

export function dnsRecordProbeIp(record, ptrIp = null) {
  const type = record?.record_type;
  const candidate = type === 'A'
    ? (record.ip_address || record.value)
    : (type === 'PTR' ? ptrIp : null);

  return isValidIpv4(candidate) ? candidate : null;
}

export function addCnameMenuItem(record, command) {
  if (record?.record_type !== 'A') return null;
  return {
    label: 'Add CNAME',
    icon: 'pi pi-plus',
    command
  };
}
