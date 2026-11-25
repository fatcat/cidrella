/**
 * What an instance's DNS and DHCP servers are doing, as the Instances page
 * shows it: 'serving', 'off' (switched off in CIDRella, or for DHCP, held by
 * another instance), 'down' (on, but the server is not running) or, for DHCP,
 * 'no_interface' (this box holds DHCP but no interface has it on). A member
 * sends its own with every sync (sync/member.js); the controller stores it
 * (noteContact) and reads its own live (routes/instances.js). The controller
 * sends every state it can vouch for back with each answer to a member's sync
 * (instanceStates, SERVICES_HEADER), and the member shows those
 * (heardInstanceStates).
 */
import { backendStatuses, getDhcpBackend } from '../backends/index.js';
import { roleSwitchedOff } from '../utils/role-switches.js';
import { selectInterfaceNames } from '../utils/interface-config.js';
import { CURRENT_MS, listInstances, reportedServiceStates } from '../models/sync-instance.js';
import { readSyncState } from '../sync/log.js';

export const SERVICE_STATES = ['serving', 'off', 'down', 'no_interface'];
const ROLES = ['dns', 'dhcp'];

/** `{ dns, dhcp }` for this box. roleSwitchedOff is the one rule for 'off'. */
export async function ownServiceStates() {
  const statuses = await backendStatuses();
  const of = (role) => {
    if (roleSwitchedOff(role)) return 'off';
    if (role === 'dhcp' && dhcpInterfaceCount() === 0) return 'no_interface';
    return statuses[role]?.running ? 'serving' : 'down';
  };
  return { dns: of('dns'), dhcp: of('dhcp') };
}

// The controller reads its own states once in a while, not for every
// member's sync: each read asks the daemons. Kept per database, which is per
// box (tests run several in one process).
const OWN_STATES_MS = 5000;
const ownReads = new WeakMap();

function recentOwnServiceStates(db) {
  let read = ownReads.get(db);
  if (!read || Date.now() - read.at > OWN_STATES_MS) {
    read = { at: Date.now(), states: ownServiceStates().catch(() => null) };
    ownReads.set(db, read);
  }
  return read.states;
}

/**
 * Every instance's `{ dns, dhcp }` this box can vouch for, by instance_id:
 * its own, and each member's while it is in contact. The controller sends it
 * with every answer to a member's sync.
 */
export async function instanceStates(db) {
  const self = readSyncState(db, 'instance_id');
  const own = await recentOwnServiceStates(db);
  const states = {};
  for (const row of listInstances(db)) {
    const known = row.instance_id === self ? own : reportedServiceStates(row);
    if (known) states[row.instance_id] = known;
  }
  return states;
}

/** instanceStates as one header value: `<instance_id>=dns:serving,dhcp:off;...` */
export function formatInstanceStates(states) {
  return Object.entries(states || {})
    .map(([id, known]) => `${id}=${formatServiceStates(known)}`)
    .filter((part) => !part.endsWith('='))
    .join(';');
}

const INSTANCE_ID = /^[0-9a-f-]{36}$/;

/** The value formatInstanceStates made, by instance_id; {} when none is usable. */
export function parseInstanceStates(text) {
  const states = {};
  if (typeof text !== 'string') return states;
  for (const part of text.slice(0, 16_384).split(';')) {
    const at = part.indexOf('=');
    const id = part.slice(0, at);
    const known = at > 0 && INSTANCE_ID.test(id) ? parseServiceStates(part.slice(at + 1)) : null;
    if (known) states[id] = known;
  }
  return states;
}

// What the controller last said, per member database.
const heard = new WeakMap();

/** Keep what the controller's answer said (the SERVICES_HEADER value). */
export function noteInstanceStates(db, text) {
  heard.set(db, { at: Date.now(), states: parseInstanceStates(text) });
}

/**
 * What this member's controller last said about every instance, or null once
 * that is older than a member's contact window: the member is then out of
 * touch, and vouches for nothing.
 */
export function heardInstanceStates(db) {
  const last = heard.get(db);
  return last && Date.now() - last.at <= CURRENT_MS ? last.states : null;
}

/**
 * How many of this box's interfaces would serve DHCP if it held DHCP
 * (Settings > General > Interfaces). A member sends it with every sync, so
 * the controller can refuse to move DHCP to an instance with none
 * (services/dhcp-move.js).
 */
export function dhcpInterfaceCount() {
  return selectInterfaceNames('dhcp').names.length;
}

/** `{ dns, dhcp }` as one query value: `dns:serving,dhcp:off`. */
export function formatServiceStates(states) {
  return ROLES.filter((role) => states?.[role])
    .map((role) => `${role}:${states[role]}`)
    .join(',');
}

/**
 * The value formatServiceStates made, or null when it holds nothing usable.
 * A role or a state it does not know is dropped: the sender may be newer.
 */
export function parseServiceStates(text) {
  if (typeof text !== 'string') return null;
  const states = {};
  for (const part of text.slice(0, 200).split(',')) {
    const [role, state] = part.split(':');
    if (ROLES.includes(role) && SERVICE_STATES.includes(state)) states[role] = state;
  }
  return Object.keys(states).length ? states : null;
}

/**
 * The DUID this box's DHCPv6 server answers with, or null (it has served no
 * DHCPv6 yet, or it cannot be read). A member sends it with every sync.
 */
export function ownDhcpv6Duid() {
  try {
    return getDhcpBackend().serverIdentity().duid || null;
  } catch {
    return null;
  }
}
