/**
 * The DNS proxy's own constants: ports, timeouts and cache sizes. The proxy
 * imports only this, never config/defaults.js, which the release build
 * rewrites (the NTP defaults) and which would change the proxy's code id on
 * every release. config/defaults.js re-exports all of these.
 */

export const GEOIP_CACHE_MAX = 10000;
export const GEOIP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// DNS-over-TCP relay (used by DNSSEC-aware / large responses).
export const PROXY_TCP_IDLE_TIMEOUT_MS = 10000; // close idle client TCP conns
export const PROXY_MAX_TCP_CONNECTIONS = 1000; // concurrent client TCP conn cap
export const PROXY_TCP_RELAY_TIMEOUT_MS = 5000; // upstream-to-dnsmasq TCP relay timeout

// Internal port dnsmasq binds on 127.0.0.1 when the proxy fronts it.
// If the user picks this same port as their LAN-facing `dns_listen_port`,
// callers should use `resolveDnsmasqInternalPort()` (below) which shifts
// dnsmasq to a different internal port so the two never fight over the
// same bind address. 5353 is the historical default.
export const DNSMASQ_INTERNAL_PORT = 5353;
export const DNSMASQ_INTERNAL_PORT_ALT = 5354;
// LAN-facing DNS port when dns_listen_port is unset or unusable.
export const DEFAULT_DNS_LISTEN_PORT = 53;
// Loopback port the in-Node encrypted-forwarder stub binds; dnsmasq forwards
// here (server=127.0.0.1#<port>) when DoT/DoH forwarding is enabled. 5356 avoids
// 5353 (mDNS, dnsmasq internal) and 5355 (LLMNR).
export const ENCRYPTED_FORWARDER_PORT = 5356;
// How long a forwarded query may take, outermost first. The DNS proxy answers
// a client SERVFAIL when dnsmasq has not answered in PROXY_UDP_TIMEOUT_MS
// (about when a client's own resolver gives up and asks again); dnsmasq itself
// waits 10 seconds (TIMEOUT in its config.h). The encrypted forwarder behind
// dnsmasq must answer inside the proxy's wait: one send gets
// ENCRYPTED_FORWARDER_TIMEOUT_MS, and every send, resend and failover to the
// next provider fits in ENCRYPTED_FORWARDER_BUDGET_MS. A provider that gave no
// answer goes to the back of the line for ENCRYPTED_FORWARDER_HOLD_MS.
export const PROXY_UDP_TIMEOUT_MS = 5000;
export const ENCRYPTED_FORWARDER_TIMEOUT_MS = 2500;
export const ENCRYPTED_FORWARDER_BUDGET_MS = 4500;
export const ENCRYPTED_FORWARDER_HOLD_MS = 30_000;

/**
 * Returns the port dnsmasq should bind internally, given the user's LAN
 * DNS listen port. Shifts away from the default if the LAN port collides.
 *
 * @param {number|null|undefined} lanListenPort user-configured dns_listen_port
 * @returns {number} internal port dnsmasq should use
 */
export function resolveDnsmasqInternalPort(lanListenPort) {
  if (Number(lanListenPort) === DNSMASQ_INTERNAL_PORT) return DNSMASQ_INTERNAL_PORT_ALT;
  return DNSMASQ_INTERNAL_PORT;
}

/**
 * The LAN-facing DNS port, from a stored `dns_listen_port` value, falling back
 * to 53 for anything that is not a usable port.
 *
 * Two callers resolved this differently. `backends/dnsmasq/dnsmasq.js` range-checked and
 * fell back to 53; `utils/dns-proxy.js` used `Number(value) || 53`, which
 * accepts anything non-zero, so a stored 70000 became a bind attempt on 70000
 * while the dnsmasq config it is supposed to sit in front of stayed on 53.
 * `/api/settings` validates this key, so the bad value only arrives from a
 * restored or hand-edited DB, which is exactly when the two halves disagreeing
 * is hardest to diagnose.
 * See REVIEW.md, duplicate-logic audit #10.
 *
 * @param {unknown} rawValue stored dns_listen_port
 * @returns {number} a port in 1-65535, or 53
 */
export function resolveDnsListenPort(rawValue) {
  const p = Number(rawValue);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_DNS_LISTEN_PORT;
}
