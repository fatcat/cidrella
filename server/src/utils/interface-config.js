import os from 'os';
import { getSetting } from '../db/init.js';

/**
 * One reading of the `interface_config` setting.
 *
 * Three call sites used to parse this setting and walk it themselves:
 * `utils/dnsmasq.js` (emitting interface= / listen-address= / no-dhcp-interface=),
 * `utils/dns-proxy.js` (collecting bind addresses) and `utils/dhcp-probe.js`
 * (collecting interfaces to probe). The dhcp-probe copy carried a comment
 * saying it "mirrors dnsmasq.js exactly", which is a drift risk stated out loud
 * rather than enforced (duplicate-logic audit #9).
 *
 * Only the SELECTION is shared here. What each caller does with the chosen
 * interfaces genuinely differs, and so do the service predicates, so this
 * deliberately returns names and lets each caller shape its own output. Folding
 * the output shaping in too would have meant one function with three modes,
 * which is not obviously better than three functions.
 */

/** Parse the stored config. Always returns an object, never throws. */
export function readInterfaceConfig() {
  try {
    const raw = getSetting('interface_config');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* fall through to the empty default */ }
  return {};
}

function enabledFor(entry, service) {
  if (!entry || typeof entry !== 'object') return false;
  // 'any' is dnsmasq's rule: it needs an interface= line for a DNS-only
  // interface as well as a DHCP one.
  if (service === 'any') return Boolean(entry.dns || entry.dhcp);
  return Boolean(entry[service]);
}

/**
 * Which host interfaces should this service act on?
 *
 * Returns { explicit, names }. `explicit` says whether the operator has a
 * stored interface_config at all, which callers need because the fallback
 * shape differs from the configured one.
 *
 * With a config: the interfaces it enables for `service` that also exist on
 * this host. Without one: every real interface, loopback excluded, matching
 * what dnsmasq itself does on a fresh deploy.
 *
 * @param {'dns'|'dhcp'|'any'} service
 */
export function selectInterfaceNames(service, { config, sysIfaces } = {}) {
  const cfg = config || readInterfaceConfig();
  const ifaces = sysIfaces || os.networkInterfaces();
  const explicit = Object.keys(cfg).length > 0;
  const names = [];

  if (explicit) {
    for (const [ifName, entry] of Object.entries(cfg)) {
      if (!enabledFor(entry, service)) continue;
      // Object.hasOwn rather than naked indexing: a stored name of
      // 'constructor', '__proto__' or 'toString' would otherwise resolve up the
      // prototype chain to a non-array and crash the caller's for...of. The
      // validator rejects those at write time, so this is defence in depth for
      // config stored before that fix landed.
      if (!Object.hasOwn(ifaces, ifName)) continue;
      names.push(ifName);
    }
  } else {
    for (const ifName of Object.keys(ifaces)) {
      if (ifName === 'lo') continue;
      names.push(ifName);
    }
  }

  return { explicit, names };
}
