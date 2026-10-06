/**
 * What every DNS/DHCP backend adapter provides. The rest of CIDRella talks to
 * a backend only through these operations (via backends/index.js and
 * services/backend-apply.js), so a second adapter (Kea, PowerDNS) slots in
 * without its callers changing.
 *
 * Apply operations are desired state: each reads the database and makes the
 * backend match it. They never write the database (scripts/check-db-ownership.js
 * refuses SQL writes under backends/), and they are idempotent: a second call
 * with nothing changed reports `changed: false`.
 *
 * @typedef {'none' | 'reload' | 'restart'} Activation
 *   What the backend needs to take a change: nothing, a reload, or a restart.
 *
 * @typedef {object} ApplyResult
 * @property {boolean} changed     the backend's configuration changed
 * @property {Activation} activation  what it took (or would take) to apply
 * @property {boolean} activated   whether that activation was performed
 *
 * @typedef {object} BackendLease  one lease as the backend reports it
 * @property {string} ip
 * @property {string|null} mac        lower case; null for DHCPv6
 * @property {string|null} hostname   the name the client asked for
 * @property {string|null} clientId
 * @property {string} expiresAt       ISO time, or 'infinite'
 * @property {4|6} dhcpVersion
 * @property {string|null} duid       DHCPv6 client DUID, lower case
 * @property {number|null} iaid
 * @property {boolean} [temporary]    DHCPv6 IA_TA address
 *
 * @typedef {object} ApplyOptions
 * @property {boolean} [activate=true]  perform the activation; false leaves it
 *   to the caller (Service.applyActivation), e.g. to batch two changes
 */

export const ACTIVATIONS = Object.freeze(['none', 'reload', 'restart']);

/** Roles a backend can fill. One backend may fill several. */
export const ROLES = Object.freeze(['dns', 'dhcp', 'ra']);

/**
 * DNS role.
 * - applyZones(db, opts) -> ApplyResult: zones and records
 * - applyResolver(db, opts) -> ApplyResult: forwarders, recursion, DNSSEC
 * - applyListen(db, opts) -> ApplyResult: listen addresses, ports, interfaces
 * - onClockSynchronized() -> void: the system clock is now trustworthy
 */
export const DNS_OPS = Object.freeze([
  'applyZones',
  'applyResolver',
  'applyListen',
  'onClockSynchronized',
]);

/**
 * DHCP role.
 * - applyScopes(db, opts) -> ApplyResult: scopes, pools, options, reservations
 * - readLeases(opts) -> Promise<{ leases: BackendLease[] } | { leases: null, unsettled: true }>
 * - watchLeases(onChange) -> stop(): calls onChange when leases may have changed
 * - releaseLease(leaseRow) -> { released, skipped?, error? }: never throws
 * - serverIdentity() -> { duid: string|null }: the server's own DHCPv6 DUID
 */
export const DHCP_OPS = Object.freeze([
  'applyScopes',
  'readLeases',
  'watchLeases',
  'releaseLease',
  'serverIdentity',
]);

/**
 * Per process (a backend filling two roles is one service).
 * - status() -> { name, running, restartPending }
 * - capabilities() -> object of booleans, keys in CAPABILITY_KEYS
 * - transaction(fn) -> fn's result: apply ops inside are validated and rolled
 *   back as one
 * - applyActivation(activation) -> void
 * - activate({ force }) -> 'restarted' | 'unchanged': make sure the running
 *   service has the applied configuration
 * - restart() -> void
 */
export const SERVICE_OPS = Object.freeze([
  'status',
  'capabilities',
  'transaction',
  'applyActivation',
  'activate',
  'restart',
]);

export const CAPABILITY_KEYS = Object.freeze([
  'dnssec',
  'routerAdvertisements',
  'dhcpv6',
  'leaseRelease',
  'encryptedUpstream',
]);

/**
 * Throw unless `backend` has every operation for the roles it claims. The
 * contract test runs this against every adapter.
 */
export function assertBackendShape(backend) {
  const problems = [];
  if (typeof backend?.name !== 'string' || !backend.name) problems.push('name');
  for (const op of SERVICE_OPS) {
    if (typeof backend?.[op] !== 'function') problems.push(op);
  }
  const roles = backend?.roles || [];
  for (const role of roles) {
    if (!ROLES.includes(role)) problems.push(`role ${role}`);
  }
  const roleOps = { dns: DNS_OPS, dhcp: DHCP_OPS, ra: [] };
  for (const role of roles) {
    for (const op of roleOps[role] || []) {
      if (typeof backend?.[role]?.[op] !== 'function') problems.push(`${role}.${op}`);
    }
  }
  if (problems.length) {
    throw new Error(`Backend ${backend?.name || '(unnamed)'} is missing: ${problems.join(', ')}`);
  }
}
