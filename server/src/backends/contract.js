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

import { FEATURES, featureById } from './features.js';

export const ACTIVATIONS = Object.freeze(['none', 'reload', 'restart']);

/** Roles a backend can fill. One backend may fill several. */
export const ROLES = Object.freeze(['dns', 'dhcp', 'ra']);

/**
 * DNS role.
 * - applyZones(db, opts) -> ApplyResult: zones and records
 * - applyResolver(db, opts) -> ApplyResult: forwarders, recursion, DNSSEC
 * - applyListen(db, opts) -> ApplyResult: listen addresses, ports, interfaces
 * - onClockSynchronized() -> void: the system clock is now trustworthy
 * - servedTtl({type, ttl}) -> number: the TTL in seconds the backend answers
 *   that record with. A backend that cannot serve a record's own TTL says what
 *   it serves instead, so the UI never shows a TTL nobody receives.
 * - retireLegacyArtifacts?() -> boolean: optional; clear files an older
 *   release left that would serve stale data
 */
export const DNS_OPS = Object.freeze([
  'applyZones',
  'applyResolver',
  'applyListen',
  'onClockSynchronized',
  'servedTtl',
]);

/**
 * DHCP role.
 * - applyScopes(db, opts) -> ApplyResult: scopes, pools, options, reservations
 * - readLeases(opts) -> Promise<{ leases: BackendLease[] } | { leases: null, unsettled: true }
 *   | { leases: null, absent: true }>: absent when the backend has never
 *   stored a lease (the lease sync skips it like an unsettled read)
 * - watchLeases(onChange) -> stop(): calls onChange when leases may have changed
 * - releaseLease(BackendLease) -> { released, skipped?, error? }, or a Promise
 *   of it: never throws or rejects
 * - serverIdentity() -> { duid: string|null }: the server's own DHCPv6 DUID
 * - importLeases?(BackendLease[], { serverDuid }) -> Promise<{ added, failed: [{ ip, error }] }>:
 *   optional; replace the backend's leases with those another backend
 *   handed out (a switch), under the DHCPv6 server DUID they carry. Called while the
 *   backend answers no DHCP; the leases count once it serves again.
 * - dhcpCounters?() -> Promise<{ received, sent }>: optional; DHCP packets
 *   since the daemon started, for a backend whose log does not show them all
 */
export const DHCP_OPS = Object.freeze([
  'applyScopes',
  'readLeases',
  'watchLeases',
  'releaseLease',
  'serverIdentity',
]);

/**
 * Router Advertisement role.
 * - applyRouterAdvertisements(db, opts) -> ApplyResult: the RAs for the
 *   DHCPv6 scopes, when another backend fills the DHCP role (while one
 *   backend fills both, its applyScopes covers them)
 */
export const RA_OPS = Object.freeze(['applyRouterAdvertisements']);

/**
 * Per process (a backend filling two roles is one service).
 * - status() -> { name, running, restartPending }
 * - capabilities() -> { [featureId]: boolean } for every feature of the roles
 *   it fills (backends/features.js; build it with declareSupport)
 * - capabilityNotes?() -> { [featureId]: string }: optional; why a feature is
 *   off, or what it depends on, in words the UI can show
 * - transaction(fn) -> fn's result: apply ops inside are validated and rolled
 *   back as one
 * - applyActivation(activation) -> void
 * - activate({ force }) -> 'restarted' | 'unchanged': make sure the running
 *   service has the applied configuration
 * - restart() -> void
 * - prepare() -> void: create what the backend needs on disk before it starts
 * - logSource() -> null, or { path, querySourceIp(line), dhcpDirection(line),
 *   isDhcpLine(line), createDhcpParser() } for a backend whose log the
 *   liveness, metrics, log viewer and fingerprint readers can use.
 *   `path` is read on every poll, so a log that moves to a new file is
 *   followed (createLogFollower in utils/log-reader.js). dhcpDirection
 *   answers 'client', 'server' or null. Readers take the DNS role's log for
 *   queries and the DHCP role's for DHCP.
 *
 * Optional, for a backend that can be switched to and from
 * (services/dhcp-backend-switch.js):
 * - installed?() -> { ok, reason? }: can it run on this host; absent means yes
 * - awaitRunning?() -> Promise: resolves once it runs its configuration and,
 *   when it serves, answers on its sockets; rejects with the reason
 * - stop?() -> void: stop a daemon that fills no role any more
 * - pruneLogs?(days) -> number: delete audit logs of its own (Kea's legal
 *   log) older than the audit retention; how many files went
 */
export const SERVICE_OPS = Object.freeze([
  'status',
  'capabilities',
  'transaction',
  'applyActivation',
  'activate',
  'restart',
  'prepare',
  'logSource',
]);

/**
 * The capability keys 0.5.1 reported in /api/health/system and /api/metrics,
 * each read from the feature catalog. Deprecated: read `features`. Removed in
 * 0.5.3. No adapter encrypts upstream queries itself (CIDRella's forwarder
 * does), so encryptedUpstream stays false.
 */
export function legacyCapabilities(caps) {
  return {
    dnssec: caps['rec-dnssec-validate'] === true,
    routerAdvertisements: caps.ra === true,
    dhcpv6: caps['dhcp6-stateful'] === true,
    leaseRelease: caps['lease-release'] === true,
    encryptedUpstream: false,
  };
}

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
  const roleOps = { dns: DNS_OPS, dhcp: DHCP_OPS, ra: RA_OPS };
  for (const role of roles) {
    for (const op of roleOps[role] || []) {
      if (typeof backend?.[role]?.[op] !== 'function') problems.push(`${role}.${op}`);
    }
  }
  if (problems.length) {
    throw new Error(`Backend ${backend?.name || '(unnamed)'} is missing: ${problems.join(', ')}`);
  }
}

/**
 * Status and capabilities per role, from `serviceFor(role)`:
 * `{ dns: {name, running, restartPending, features, capabilities}, dhcp: {...}, ra: {...} }`,
 * where `features` is the service's capabilities() and `capabilities` the
 * deprecated legacy keys.
 * Each distinct service is asked once, so roles sharing a daemon cost one
 * status check and report the same object.
 */
export function roleStatuses(serviceFor) {
  const byService = new Map();
  return Object.fromEntries(
    ROLES.map((role) => {
      const service = serviceFor(role);
      if (!byService.has(service)) {
        const features = service.capabilities();
        byService.set(service, {
          ...service.status(),
          features,
          capabilities: legacyCapabilities(features),
        });
      }
      return [role, byService.get(service)];
    }),
  );
}

/**
 * Does the service `serviceFor(role)` filling the feature's role support it?
 * `id` is a backends/features.js id; an unknown one throws.
 */
export function featureSupported(serviceFor, id) {
  const feature = featureById(id);
  if (!feature) throw new Error(`Unknown backend feature: ${id}`);
  return serviceFor(feature.role).capabilities()[id] === true;
}

/**
 * Every catalog feature with whether the service filling its role supports
 * it, which backend that is, the backend's note on it, and (when off) the
 * reason the API answers and the UI shows. Each service is asked once.
 */
export function featureReportFor(serviceFor) {
  const byService = new Map();
  const answers = (service) => {
    if (!byService.has(service)) {
      byService.set(service, {
        supported: service.capabilities(),
        notes: service.capabilityNotes?.() || {},
      });
    }
    return byService.get(service);
  };
  return FEATURES.map((f) => {
    const service = serviceFor(f.role);
    const { supported, notes } = answers(service);
    const ok = supported[f.id] === true;
    const note = notes[f.id] || null;
    const base = `${f.label} is not available with ${service.name}.`;
    return {
      id: f.id,
      role: f.role,
      label: f.label,
      backend: service.name,
      supported: ok,
      note,
      reason: ok ? null : note ? `${base} ${note}` : base,
    };
  });
}
