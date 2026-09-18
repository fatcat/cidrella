/**
 * The global IPv6 switch.
 *
 * `ipv6_enabled` is off on a new install and on every upgrade. While it is
 * off the appliance behaves as an IPv4 product: no IPv6 listeners, no DHCPv6
 * or Router Advertisement probes, no scheduled IPv6 scans, host IPv6
 * addresses hidden, and every route that would create an IPv6 object refuses
 * with the one message below. Rows that already exist stay readable and
 * deletable, so turning the switch off never hides or destroys data.
 *
 * The switch is persisted and applied by PUT /api/interfaces/config, which
 * regenerates dnsmasq and rebinds the resolver in the same request. It is
 * deliberately not editable through the generic settings route, like every
 * other setting that applies configuration.
 */

import { getSetting } from '../db/init.js';

export const IPV6_DISABLED_ERROR =
  'IPv6 support is disabled. Enable it under Settings > General > Interfaces.';

/** Is IPv6 support switched on? Read at call time, never cached. */
export function ipv6Enabled() {
  try {
    return getSetting('ipv6_enabled') === 'true';
  } catch {
    // No database yet (unit tests that never open one). Closed by default.
    return false;
  }
}

/**
 * Send the 400 and return true when IPv6 is off. Call it only after the route
 * knows the request is IPv6, so IPv4 requests never pay for the lookup:
 *   if (parsed.family === 6 && refuseIpv6Unless(res)) return;
 */
export function refuseIpv6Unless(res) {
  if (ipv6Enabled()) return false;
  res.status(400).json({ error: IPV6_DISABLED_ERROR });
  return true;
}
