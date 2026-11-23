/**
 * What an instance's DNS and DHCP servers are doing, as the Instances page
 * shows it: 'serving', 'off' (switched off in CIDRella, or for DHCP, held by
 * another instance) or 'down' (on, but the server is not running). A member
 * sends its own with every sync (sync/member.js); the controller stores it
 * (noteContact) and reads its own live (routes/instances.js).
 */
import { backendStatuses, getDhcpBackend } from '../backends/index.js';
import { roleSwitchedOff } from '../utils/role-switches.js';

export const SERVICE_STATES = ['serving', 'off', 'down'];
const ROLES = ['dns', 'dhcp'];

/** `{ dns, dhcp }` for this box. roleSwitchedOff is the one rule for 'off'. */
export async function ownServiceStates() {
  const statuses = await backendStatuses();
  const of = (role) => {
    if (roleSwitchedOff(role)) return 'off';
    return statuses[role]?.running ? 'serving' : 'down';
  };
  return { dns: of('dns'), dhcp: of('dhcp') };
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
