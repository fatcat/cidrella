/**
 * The DNS and DHCP switches in CIDRella (Settings > General > Interfaces):
 * a role switched off is served by no one, whichever stack is chosen. Every
 * reader asks here: the backend registry (servesDhcp, the status `off` flag)
 * and the DNS proxy.
 */
import { getSetting } from '../db/init.js';

// The setting behind each role, on unless 'false'.
const ROLE_SWITCHES = { dns: 'dns_enabled', dhcp: 'dhcp_enabled' };

/** Is `role` switched off? Router Advertisements have no switch. */
export function roleSwitchedOff(role) {
  return ROLE_SWITCHES[role] ? getSetting(ROLE_SWITCHES[role]) === 'false' : false;
}
