/**
 * Which backend fills each role (DNS, DHCP, Router Advertisements). A host
 * runs one stack, never a mix: dnsmasq for all three, or PowerDNS for DNS,
 * Kea for DHCP and radvd for the Router Advertisements. The `backend_stack`
 * setting names it; only services/stack-switch.js and boot change it.
 * Only server/src/backends/** may import an adapter directly (enforced by
 * ESLint and scripts/check-backend-imports.js).
 *
 * Instances are built on first use and do no I/O while being built.
 */
import { ROLES, featureReportFor, featureSupported, roleStatuses } from './contract.js';
import { createDnsmasqBackend } from './dnsmasq/index.js';
import { createKeaBackend } from './kea/index.js';
import { createPdnsBackend } from './pdns/index.js';
import { createRadvdBackend } from './radvd/index.js';
import { unitEvents } from './shared/unit-events.js';
import { getSetting } from '../db/init.js';

const FACTORIES = {
  dnsmasq: createDnsmasqBackend,
  kea: createKeaBackend,
  pdns: createPdnsBackend,
  radvd: createRadvdBackend,
};

/** The stacks, as the setting names them, and the backend in each role. */
export const STACKS = Object.freeze({
  dnsmasq: Object.freeze({ dns: 'dnsmasq', dhcp: 'dnsmasq', ra: 'dnsmasq' }),
  'pdns-kea': Object.freeze({ dns: 'pdns', dhcp: 'kea', ra: 'radvd' }),
});
export const DEFAULT_STACK = 'dnsmasq';

const instances = {};
let stack = DEFAULT_STACK;
// Backends told to answer no DHCP while a switch moves the leases.
const quiesced = new Set();
const listeners = new Set();

/**
 * Does `name` answer DHCP right now? Only the stack's DHCP backend does, not
 * while a switch holds it quiet, and not while DHCP is switched off
 * (`dhcp_enabled`, on unless 'false'). A backend not answering still renders
 * its configuration, with no addresses to hand out.
 */
export function servesDhcp(name) {
  return (
    STACKS[stack].dhcp === name && !quiesced.has(name) && getSetting('dhcp_enabled') !== 'false'
  );
}

/** The adapter instance by name, whatever role it fills now. */
export function getBackend(name) {
  if (!FACTORIES[name]) throw new Error(`Unknown backend: ${name}`);
  return (instances[name] ||= FACTORIES[name]({ servesDhcp: () => servesDhcp(name) }));
}

/** The backend service filling `role`: its status, capabilities and activation. */
export function getService(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown backend role: ${role}`);
  return getBackend(STACKS[stack][role]);
}

export const getDnsBackend = () => getService('dns').dns;
export const getDhcpBackend = () => getService('dhcp').dhcp;
/** The service sending Router Advertisements. */
export const getRaBackend = () => getService('ra');
/** The stack serving now. */
export const stackName = () => stack;

/** Each backend of `name`'s stack once, however many roles it fills. */
export const stackServices = (name) => [...new Set(Object.values(STACKS[name]))].map(getBackend);

/**
 * Make `name` the stack. Boot sets it from the setting; the switch moves it.
 * Listeners (onBackendChanged) hear of each role that moved.
 */
export function selectStack(name) {
  if (!STACKS[name]) throw new Error(`Unknown backend stack: ${name}`);
  if (name === stack) return;
  const before = STACKS[stack];
  stack = name;
  for (const role of ROLES) {
    if (before[role] === STACKS[name][role]) continue;
    for (const listener of listeners) {
      try {
        listener(role);
      } catch (err) {
        console.warn('Backend change listener failed:', err.message);
      }
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

/**
 * Follow the daemons starting and stopping (backends/shared/unit-events.js):
 * fn({ action, unit, processName, error }). Returns the unsubscribe.
 */
export function onUnitEvent(fn) {
  unitEvents.on('unit', fn);
  return () => unitEvents.off('unit', fn);
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
