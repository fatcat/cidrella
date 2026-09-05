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

export function isImmutableNetworkAddress(row) {
  return row?.range_type_name === 'Network' || row?.range_type_name === 'Broadcast';
}
