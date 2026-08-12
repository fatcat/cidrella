/**
 * One definition of "a MAC address in some text", and of the one MAC that
 * means "no answer".
 *
 * The regex was character-identical in utils/arp-cache.js and
 * utils/dhcp-fingerprint.js, but only arp-cache knew that 00:00:00:00:00:00 is
 * not a device. arping prints the all-zero MAC for an unanswered probe and
 * dnsmasq logs it on a DHCP packet with no client hardware address, so the
 * fingerprinter happily recorded a device whose MAC was the null MAC,
 * accumulating every such packet on the network into one phantom host.
 *
 * Deliberately dependency-free so both callers can use it without dragging in
 * the DB layer that utils/mac-vendor.js needs.
 * See REVIEW.md, duplicate-logic audit #13.
 */

/** A canonical 6-octet MAC anywhere in the text. */
export const MAC_RE = /\b([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\b/;

/** arping's "no reply" placeholder, and dnsmasq's empty client hwaddr. */
export const NULL_MAC = '00:00:00:00:00:00';

/** True when this is the all-zero MAC, in any case or spacing. */
export function isNullMac(mac) {
  return String(mac || '').trim().toLowerCase() === NULL_MAC;
}

/**
 * First real MAC in `text`, lowercased, or null.
 * Returns null for the all-zero MAC: it parses fine and means nothing.
 */
export function extractMac(text) {
  const m = String(text ?? '').match(MAC_RE);
  if (!m) return null;
  const mac = m[1].toLowerCase();
  return isNullMac(mac) ? null : mac;
}
