// The DNS and DHCP backends from a health payload (/api/health/system or
// /api/metrics/services), as one unit per daemon with the roles it fills:
// dnsmasq today is one unit doing DNS, DHCP and Router Advertisements, and
// after the move to Kea and PowerDNS each will be its own unit.
//
// A server older than 0.5.1 sends only a dnsmasq flag (`services.dnsmasq` on
// health, top-level `dnsmasq` on metrics). That reads as one dnsmasq unit.

const ROLE_OUTAGE = {
  dns: 'DNS answers',
  dhcp: 'DHCP leases',
  ra: 'Router Advertisements',
};

/** [{ key, name, roles, running, restartPending }], in role order. */
export function backendUnits(payload) {
  if (!payload) return [];
  if (payload.backends) {
    const units = new Map();
    for (const [role, status] of Object.entries(payload.backends)) {
      if (!status?.name) continue;
      const unit = units.get(status.name) || {
        key: status.name,
        name: status.name,
        roles: [],
        running: status.running === true,
        restartPending: status.restartPending === true,
      };
      unit.roles.push(role);
      units.set(status.name, unit);
    }
    return [...units.values()];
  }
  const running = payload.services?.dnsmasq ?? payload.dnsmasq;
  if (typeof running !== 'boolean') return [];
  return [
    { key: 'dnsmasq', name: 'dnsmasq', roles: ['dns', 'dhcp', 'ra'], running, restartPending: false },
  ];
}

/** True when any backend unit reports it is not running. */
export function anyBackendDown(payload) {
  return backendUnits(payload).some((unit) => !unit.running);
}

/** What stops while `unit` is down: "No DNS answers or DHCP leases until it is back". */
export function outageDetail(unit) {
  // Router Advertisements are named only when they are all the unit does;
  // next to DNS and DHCP they are a detail.
  const roles = unit.roles.length > 1 ? unit.roles.filter((r) => r !== 'ra') : unit.roles;
  const named = roles.map((role) => ROLE_OUTAGE[role]).filter(Boolean);
  if (!named.length) return 'Not running';
  return `No ${named.join(' or ')} until it is back`;
}
