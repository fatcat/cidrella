export const ADDRESS_TYPE_STATIC_DNS = {
  label: 'static DNS',
  className: 'type-static-dns'
};

export const ADDRESS_TYPE_DYNAMIC_DHCP = {
  label: 'dynamic DHCP',
  className: 'type-dynamic-dhcp'
};

export const ADDRESS_TYPE_RESERVED_DHCP = {
  label: 'DHCP Reservation',
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

export const ADDRESS_TYPE_RESERVED = {
  label: 'IP Reservation',
  className: 'type-reserved'
};

export const ADDRESS_TYPE_SLAAC = {
  label: 'SLAAC',
  className: 'type-slaac'
};

export const ADDRESS_TYPE_QUARANTINED = {
  label: 'quarantined',
  className: 'type-quarantined'
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
  [ADDRESS_TYPE_RESERVED.label]: ADDRESS_TYPE_RESERVED,
  [ADDRESS_TYPE_SLAAC.label]: ADDRESS_TYPE_SLAAC,
  [ADDRESS_TYPE_QUARANTINED.label]: ADDRESS_TYPE_QUARANTINED,
  [ADDRESS_TYPE_ROGUE.label]: ADDRESS_TYPE_ROGUE
};

export function ipLifecycleDisplay(data) {
  return {
    status: data.ip_display_status || 'unknown',
    statusSeverity: data.ip_status_severity || 'secondary',
    addressType: data.address_type
      ? (ADDRESS_TYPE_BY_LABEL[data.address_type] || { ...ADDRESS_TYPE_UNKNOWN, label: data.address_type })
      : null,
    tooltip: data.address_type_tooltip || null
  };
}

export function ipLifecycleDisplayForDhcpRow(row) {
  return ipLifecycleDisplay(row);
}
