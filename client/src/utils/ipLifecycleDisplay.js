export const ADDRESS_TYPE_STATIC_DNS = {
  label: 'static DNS',
  className: 'type-static-dns'
};

export const ADDRESS_TYPE_DYNAMIC_DHCP = {
  label: 'dynamic DHCP',
  className: 'type-dynamic-dhcp'
};

export const ADDRESS_TYPE_RESERVED_DHCP = {
  label: 'reserved DHCP',
  className: 'type-reserved-dhcp'
};

export const ADDRESS_TYPE_SYSTEM = {
  label: 'system',
  className: 'type-system'
};

export const ADDRESS_TYPE_GATEWAY = {
  label: 'gateway',
  className: 'type-gateway'
};

export const ADDRESS_TYPE_LOCKED = {
  label: 'locked',
  className: 'type-locked'
};

export const ADDRESS_TYPE_ROGUE = {
  label: 'rogue',
  className: 'type-rogue'
};

export const ADDRESS_TYPE_UNKNOWN = {
  label: 'unknown',
  className: 'type-unknown'
};

const ADDRESS_TYPE_BY_LABEL = {
  [ADDRESS_TYPE_STATIC_DNS.label]: ADDRESS_TYPE_STATIC_DNS,
  [ADDRESS_TYPE_DYNAMIC_DHCP.label]: ADDRESS_TYPE_DYNAMIC_DHCP,
  [ADDRESS_TYPE_RESERVED_DHCP.label]: ADDRESS_TYPE_RESERVED_DHCP,
  [ADDRESS_TYPE_SYSTEM.label]: ADDRESS_TYPE_SYSTEM,
  [ADDRESS_TYPE_GATEWAY.label]: ADDRESS_TYPE_GATEWAY,
  [ADDRESS_TYPE_LOCKED.label]: ADDRESS_TYPE_LOCKED,
  [ADDRESS_TYPE_ROGUE.label]: ADDRESS_TYPE_ROGUE
};

export function addressTypeForDnsSource(source) {
  if (source === 'reservation') return ADDRESS_TYPE_RESERVED_DHCP;
  if (source === 'dhcp') return ADDRESS_TYPE_DYNAMIC_DHCP;
  return ADDRESS_TYPE_STATIC_DNS;
}

export function addressTypeForDhcpAssignment(assignmentType) {
  if (!assignmentType) return null;
  return assignmentType === 'reserved' ? ADDRESS_TYPE_RESERVED_DHCP : ADDRESS_TYPE_DYNAMIC_DHCP;
}

export function ipLifecycleDisplay(data) {
  if (data.address_type || data.ip_display_status) {
    return {
      status: data.ip_display_status || (data.address_type ? 'in use' : 'available'),
      statusSeverity: data.ip_status_severity || (data.address_type ? 'danger' : 'secondary'),
      addressType: data.address_type ? (ADDRESS_TYPE_BY_LABEL[data.address_type] || { ...ADDRESS_TYPE_UNKNOWN, label: data.address_type }) : null,
      tooltip: data.address_type_tooltip || null
    };
  }

  const isDhcpScope = data.range_type_name === 'DHCP Scope';
  const isLeaseExpired = data.dhcp_expires_at && data.dhcp_expires_at !== 'infinite'
    && new Date(data.dhcp_expires_at) < new Date();
  const hasActiveLease = data.dhcp_expires_at && !isLeaseExpired;
  const isOnline = data.is_online === true || data.is_online === 1 || data.is_online === '1';
  const hasDhcpReservation = data.has_dhcp_reservation === true
    || data.has_dhcp_reservation === 1
    || data.has_dhcp_reservation === '1';
  const hasStaticDns = data.has_static_dns === true
    || data.has_static_dns === 1
    || data.has_static_dns === '1';
  const isRogue = data.is_rogue === true || data.is_rogue === 1 || data.is_rogue === '1';
  const isStaticDns = hasStaticDns || (data.detection_source === 'dns' && !!data.hostname);
  const ipLifecycleStatus = data.ip_lifecycle_status || data.ip_status || data.status;

  if (data.range_type_name === 'Network' || data.range_type_name === 'Broadcast') {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_SYSTEM };
  }

  if (data.range_type_name === 'Gateway') {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_GATEWAY };
  }

  if (isRogue) {
    return {
      status: 'in use',
      statusSeverity: 'danger',
      addressType: ADDRESS_TYPE_ROGUE,
      tooltip: data.rogue_reason || null
    };
  }

  if (isOnline && ipLifecycleStatus === 'available' && !hasDhcpReservation && !data.hostname && !hasActiveLease) {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_ROGUE };
  }

  if (hasDhcpReservation) {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_RESERVED_DHCP };
  }

  if (hasActiveLease) {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_DYNAMIC_DHCP };
  }

  if (ipLifecycleStatus === 'locked') {
    return {
      status: 'in use',
      statusSeverity: 'danger',
      addressType: ADDRESS_TYPE_LOCKED,
      tooltip: data.reservation_note || null
    };
  }

  if (ipLifecycleStatus === 'assigned' || isStaticDns) {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_STATIC_DNS };
  }

  if (isOnline && (ipLifecycleStatus === 'available' || ipLifecycleStatus === 'dhcp')) {
    return { status: 'in use', statusSeverity: 'danger', addressType: ADDRESS_TYPE_ROGUE };
  }

  if (isDhcpScope) {
    return { status: 'available', statusSeverity: 'secondary', addressType: null };
  }

  return { status: 'available', statusSeverity: 'secondary', addressType: null };
}

export function ipLifecycleDisplayForDhcpRow(row) {
  const dhcpAssignmentType = row.dhcp_assignment_type;
  return ipLifecycleDisplay({
    ...row,
    range_type_name: 'DHCP Scope',
    ip_lifecycle_status: row.ip_lifecycle_status || (dhcpAssignmentType === 'dynamic' ? 'dhcp' : 'available'),
    dhcp_expires_at: row.dhcp_expires_at ?? (dhcpAssignmentType === 'dynamic' ? row.expires_at : null),
    has_dhcp_reservation: row.has_dhcp_reservation ?? (dhcpAssignmentType === 'reserved' ? 1 : 0)
  });
}
