/**
 * Which backend fills each role (DNS, DHCP, Router Advertisements). dnsmasq
 * fills DNS and the Router Advertisements; DHCP is dnsmasq or Kea, chosen by
 * the `dhcp_backend` setting and changed only by services/dhcp-backend-switch.js.
 * Only server/src/backends/** may import an adapter directly (enforced by
 * ESLint and scripts/check-backend-imports.js).
 *
 * Instances are built on first use and do no I/O while being built.
 */
import { ROLES, featureReportFor, featureSupported, roleStatuses } from './contract.js';
import { createDnsmasqBackend } from './dnsmasq/index.js';
import { createKeaBackend } from './kea/index.js';

const FACTORIES = { dnsmasq: createDnsmasqBackend, kea: createKeaBackend };

/** The backends that can fill the DHCP role, as the setting names them. */
export const DHCP_BACKENDS = Object.freeze(Object.keys(FACTORIES));
export const DEFAULT_DHCP_BACKEND = 'dnsmasq';

const instances = {};
let dhcpName = DEFAULT_DHCP_BACKEND;
// Backends told to answer no DHCP while a switch moves the leases.
const quiesced = new Set();
const listeners = new Set();

/**
 * Does `name` answer DHCP right now? Only the selected DHCP backend does, and
 * not while a switch holds it quiet. A backend not answering still renders
 * its configuration, with no addresses to hand out.
 */
export function servesDhcp(name) {
  return dhcpName === name && !quiesced.has(name);
}

/** The adapter instance by name, whatever role it fills now. */
export function getBackend(name) {
  if (!FACTORIES[name]) throw new Error(`Unknown backend: ${name}`);
  return (instances[name] ||= FACTORIES[name]({ servesDhcp: () => servesDhcp(name) }));
}

/** The backend service filling `role`: its status, capabilities and activation. */
export function getService(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown backend role: ${role}`);
  return getBackend(role === 'dhcp' ? dhcpName : 'dnsmasq');
}

export const getDnsBackend = () => getService('dns').dns;
export const getDhcpBackend = () => getService('dhcp').dhcp;
/** The service sending Router Advertisements. */
export const getRaBackend = () => getService('ra');
/** The name of the backend filling the DHCP role. */
export const dhcpBackendName = () => dhcpName;

/**
 * Make `name` the DHCP backend. Boot sets it from the setting; the switch
 * moves it. Listeners (onBackendChanged) hear of a change.
 */
export function selectDhcpBackend(name) {
  if (!FACTORIES[name]) throw new Error(`Unknown DHCP backend: ${name}`);
  if (name === dhcpName) return;
  dhcpName = name;
  for (const listener of listeners) {
    try {
      listener('dhcp');
    } catch (err) {
      console.warn('Backend change listener failed:', err.message);
    }
  }
}

/** Hold `name` quiet (serving false) or let it answer DHCP again. */
export function setDhcpServing(name, serving) {
  if (serving) quiesced.delete(name);
  else quiesced.add(name);
}

/**
 * Call `fn(role)` whenever a role moves to another backend, for what is bound
 * to one: the lease watcher, the fingerprint watcher, the metrics log tails.
 * Returns the unsubscribe.
 */
export function onBackendChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every backend CIDRella has, whether or not it fills a role now. */
export const allBackends = () => Object.keys(FACTORIES).map(getBackend);

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
