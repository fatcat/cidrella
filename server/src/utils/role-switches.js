/**
 * The DNS and DHCP switches in CIDRella (Settings > General > Interfaces):
 * a role switched off is served by no one, whichever stack is chosen. Every
 * reader asks here: the backend registry (servesDhcp, the status `off` flag),
 * the adapters and the DNS proxy.
 *
 * DHCP is off on every instance but the one that serves it, whatever its own
 * switch says: servesDhcpHere (sync/dhcp-active.js) is that rule, and it
 * reads `dhcp_enabled` on the controller.
 */
import { getSetting } from '../db/init.js';
import { servesDhcpHere } from '../sync/dhcp-active.js';

/** Is `role` switched off? Router Advertisements have no switch. */
export function roleSwitchedOff(role) {
  if (role === 'dhcp') return !servesDhcpHere();
  // On unless 'false'.
  return role === 'dns' ? getSetting('dns_enabled') === 'false' : false;
}
