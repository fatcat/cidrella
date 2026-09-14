/**
 * Display formatting for IP lifecycle history events.
 *
 * `ipLifecycleDisplay.js` formats the canonical current state (status, type).
 * This file formats the recorded history: one label, tone and detail line per
 * `ip_events` row. It was duplicated in IpDetailsDrawer.vue and
 * AddressDetailsPanel.vue with different wording; the union lives here so the
 * two interfaces read the same history the same way.
 *
 * Presentation only. Nothing here decides allocation or precedence; an
 * unknown event type falls through to a readable form of its raw name rather
 * than being reinterpreted.
 */

const EVENT_LABELS = {
  online: 'Online',
  offline: 'Offline',
  scanned: 'Scanned',
  rogue_detected: 'Rogue detected',
  rogue_cleared: 'Rogue cleared',
  dns_added: 'DNS added',
  dns_removed: 'DNS removed',
  lease_obtained: 'Lease obtained',
  hostname_changed: 'Hostname changed',
  mac_changed: 'MAC changed',
  allocation_changed: 'Allocation changed',
  status_changed: 'Legacy status changed',
  scan_enabled_changed: 'Scan setting changed',
  // Scope-only addresses lose learned metadata through retirement while their
  // current status stays DHCP Scope. History says the metadata expired, not
  // that the address was released.
  retired: 'Metadata Expired',
};

const SOURCE_LABELS = {
  scanner: 'active scan',
  passive: 'passive (DNS log)',
  stale: 'staleness timeout',
  dns: 'DNS',
  dhcp_reservation: 'DHCP Reservation',
  dhcp_lease: 'DHCP Lease',
  manual: 'manual',
  offline: 'went offline',
  retirement: 'automatic cleanup',
};

/** Tone to vendor Tag severity, for the current-interface drawer. */
export const EVENT_TONE_SEVERITY = {
  good: 'success',
  danger: 'danger',
  warn: 'warn',
  muted: 'secondary',
  info: 'info',
};

export function eventLabel(type) {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  return String(type || 'Event').replaceAll('_', ' ');
}

export function eventTone(type) {
  if (['online', 'dns_added', 'lease_obtained'].includes(type)) return 'good';
  if (type === 'rogue_detected') return 'danger';
  if (type === 'rogue_cleared') return 'warn';
  if (['offline', 'dns_removed', 'retired'].includes(type)) return 'muted';
  return 'info';
}

export function eventSourceLabel(source) {
  if (!source) return '';
  return SOURCE_LABELS[source] || String(source).replaceAll('_', ' ');
}

/** "old → new · via source", dropping whichever parts the row lacks. */
export function eventDetail(event) {
  const values =
    event.old_value && event.new_value
      ? `${event.old_value} → ${event.new_value}`
      : event.new_value || event.old_value || '';
  const source = eventSourceLabel(event.source);
  return [values, source ? `via ${source}` : ''].filter(Boolean).join(' · ');
}
