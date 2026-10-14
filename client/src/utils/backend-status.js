// The DNS and DHCP backends from a health payload (/api/health/system or
// /api/metrics/services), as one unit per daemon with the roles it fills:
// dnsmasq is one unit doing DNS, DHCP and Router Advertisements; on the
// PowerDNS + Kea stack each role is its own unit. `name` is the server's
// display label (PowerDNS, Kea, radvd). A unit stopped on purpose (radvd with
// nothing to advertise) is `idle` and counts as running: nothing is missing.
// A unit whose roles are all switched off in CIDRella is `off` and counts as
// running too: the daemon may be up, but it serves no one on purpose.
//
// A server older than 0.5.1 sends only a dnsmasq flag (`services.dnsmasq` on
// health, top-level `dnsmasq` on metrics). That reads as one dnsmasq unit.

const ROLE_OUTAGE = {
  dns: 'DNS answers',
  dhcp: 'DHCP leases',
  ra: 'Router Advertisements',
};

/** [{ key, name, roles, running, idle, off, restartPending }], in role order. */
export function backendUnits(payload) {
  if (!payload) return [];
  if (payload.backends) {
    const units = new Map();
    for (const [role, status] of Object.entries(payload.backends)) {
      if (!status?.name) continue;
      const idle = status.idle === true && status.running !== true;
      const off = status.off === true;
      const unit = units.get(status.name) || {
        key: status.name,
        name: status.label || status.name,
        roles: [],
        running: status.running === true || idle || off,
        idle,
        off,
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
    {
      key: 'dnsmasq',
      name: 'dnsmasq',
      roles: ['dns', 'dhcp', 'ra'],
      running,
      idle: false,
      off: false,
      restartPending: false,
    },
  ];
}

/**
 * A unit's state for a chip: `{ value, tone }`. Switched off and idle are
 * quiet (muted), not failures.
 */
export function unitState(unit) {
  if (unit.off) return { value: 'Off', tone: 'muted' };
  if (unit.idle) return { value: 'Idle', tone: 'muted' };
  return unit.running ? { value: 'Running', tone: 'ok' } : { value: 'Stopped', tone: 'err' };
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
