// Shared belt-and-suspenders sanitizer for values that land in dnsmasq
// config files. The individual route-level validators (isValidDomain,
// isValidIpv4, isValidPtrName, etc.) are the primary defense; this one
// catches anything that slips past them before string-interpolating into
// a config line.
//
// dnsmasq parses its config line by line. A raw `\n` inside a field lets
// an attacker append arbitrary directives (address=, server=, dhcp-option=),
// which was the C2/C3/H2 class in the v0.4.14 pentest.

/**
 * Return null if the value is safe to inline into a dnsmasq directive,
 * or a short error string describing the rejection.
 *
 * @param {string} value
 * @param {object} [opts]
 * @param {boolean} [opts.allowComma=false]  Option-list fields (e.g. DNS servers) legitimately contain commas.
 * @param {boolean} [opts.allowEquals=false]  Rare — used only when the value is itself a quoted TXT record payload.
 */
export function validateDnsmasqConfigValue(value, opts = {}) {
  const { allowComma = false, allowEquals = false } = opts;
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'must not be empty';
  if (value.length > 4096) return 'is too long';
  if (/[\r\n]/.test(value)) return 'must not contain newlines';
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return 'must not contain control characters';
  if (!allowEquals && value.includes('=')) return 'must not contain =';
  if (!allowComma && value.includes(',')) return 'must not contain ,';
  return null;
}

/**
 * PTR record `name` column is the unreversed octet list BEFORE it's joined
 * with the reverse-zone name. Restricting to digits and dots means the
 * generated `ptr-record=<name>.<zone>,<value>` line is safe by construction.
 */
export function isValidPtrName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 63 &&
    /^[0-9]+(\.[0-9]+)*$/.test(name)
  );
}

/**
 * TXT record `value` column lands inside `txt-record=<fqdn>,"..."`. The
 * writer escapes `"` but nothing else — we must refuse anything that would
 * terminate the line prematurely or emit a new directive.
 */
export function validateTxtValue(value) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'must not be empty';
  if (value.length > 4096) return 'is too long';
  if (/[\r\n]/.test(value)) return 'must not contain newlines';
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return 'must not contain control characters';
  return null;
}
