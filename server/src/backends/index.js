/**
 * Which backend fills each role (DNS, DHCP, Router Advertisements). Today
 * dnsmasq fills all three; the registry is where a setting will choose
 * another adapter. Only server/src/backends/** may import an adapter
 * directly (enforced by ESLint and scripts/check-backend-imports.js).
 *
 * The instance is built on first use and does no I/O while being built.
 */
import { ROLES, featureReportFor, featureSupported, roleStatuses } from './contract.js';
import { createDnsmasqBackend } from './dnsmasq/index.js';

let dnsmasq = null;

/** The backend service filling `role`: its status, capabilities and activation. */
export function getService(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown backend role: ${role}`);
  return (dnsmasq ||= createDnsmasqBackend());
}

export const getDnsBackend = () => getService('dns').dns;
export const getDhcpBackend = () => getService('dhcp').dhcp;
/** The service sending Router Advertisements. */
export const getRaBackend = () => getService('ra');

/** Each backend service once, however many roles it fills. */
export function uniqueServices() {
  return [...new Set(ROLES.map(getService))];
}

/**
 * What the health endpoints report per role: see roleStatuses in contract.js.
 */
export const backendStatuses = () => roleStatuses(getService);

/** Does the backend filling the feature's role support it? See featureSupported. */
export const supports = (id) => featureSupported(getService, id);

/** Every catalog feature and its support: see featureReportFor in contract.js. */
export const featureReport = () => featureReportFor(getService);
