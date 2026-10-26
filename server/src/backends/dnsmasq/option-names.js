/**
 * How dnsmasq's dhcp-option= spells an option. DHCPv4 options are written by
 * number. DHCPv6 options use dnsmasq's `option6:` name where dnsmasq has one
 * (from `dnsmasq --help dhcp6`, 2.91) and the number otherwise: dnsmasq
 * refuses a name it does not know (`option6:captive-portal` is a "bad
 * dhcp-option"), while every number is accepted.
 */
const DNSMASQ_OPTION6_NAMES = Object.freeze({
  21: 'sip-server-domain',
  22: 'sip-server',
  23: 'dns-server',
  24: 'domain-search',
  27: 'nis-server',
  28: 'nis+-server',
  29: 'nis-domain',
  30: 'nis+-domain',
  31: 'sntp-server',
  32: 'information-refresh-time',
  41: 'posix-timezone',
  42: 'tzdb-timezone',
  56: 'ntp-server',
  59: 'bootfile-url',
  60: 'bootfile-param',
});

export function dnsmasqOptionToken(code, family) {
  if (family === 4) return String(code);
  return `option6:${DNSMASQ_OPTION6_NAMES[code] ?? code}`;
}

// The DHCPv4 codes dnsmasq's own table gives a size or a type
// (src/dhcp-common.c opttab, the same 2.91 through 2.93). dnsmasq parses a
// value for one of these by the table. Any other code, including the ones the
// table lists with size 0 (47, 60, 77, 80, 94, 97, 120, 121, 125), it reads by
// the value's shape (src/option.c parse_dhcp_opt): digits are a number of the
// smallest width that holds it, colon-separated hex is bytes, dotted digits
// are addresses, and only what is none of those is text.
const DNSMASQ_TYPED_OPTION4 = new Set([
  1, 2, 3, 6, 7, 9, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 26, 27, 28, 31, 32, 33, 34, 35, 36,
  37, 38, 40, 41, 42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 64, 65,
  66, 67, 68, 69, 70, 71, 74, 81, 82, 93, 100, 101, 108, 118, 119, 150, 255,
]);

// Catalog text options that hold a plain string (a path, a name, a URL) and
// that dnsmasq does not type. The Kea adapter writes these as strings too.
// The other untyped text options (25, 43, 63, 77, 121) take dnsmasq's own
// value syntax on purpose: hex bytes, numbers, address pairs.
const STRING_OPTION4 = new Set([14, 47, 60, 62, 252]);

const WIDTH_SUFFIX = { 1: 'b', 2: 's', 4: 'i' };

// Whether dnsmasq reads a value for an untyped code as text: a port of the
// value classification in parse_dhcp_opt, DHCPv4 only.
export function dnsmasqReadsAsText(value) {
  let isAddr = true;
  let isHex = true;
  let isDec = true;
  let foundDigit = false;
  let digs = 1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === ',' || c === '.' || c === ' ') {
      isDec = isHex = false;
    } else if (c === ':') {
      digs++;
      isDec = isAddr = false;
    } else if (c === '/') {
      isDec = isHex = false;
      if (i === 0) isAddr = false;
    } else if (c === '-') {
      isHex = isAddr = false;
    } else if (c >= '0' && c <= '9') {
      foundDigit = true;
    } else {
      isAddr = false;
      if (!(i === value.length - 1 && isDec && 'bsi'.includes(c))) isDec = false;
      if (!/[A-Fa-f]/.test(c)) isHex = false;
    }
  }
  if (!foundDigit) isDec = isAddr = false;
  return !((isHex && digs > 1) || isDec || isAddr);
}

// Text as bytes dnsmasq copies as they are: colon-separated hex, or for one
// byte a number one byte wide.
function textAsBytes(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  if (bytes.length === 1) return `${bytes[0]}b`;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

// Each number `width` bytes, big-endian, as colon-separated hex.
function numberListBytes(text, width) {
  return text
    .split(',')
    .flatMap((item) => {
      const value = Number(item.trim());
      return Array.from({ length: width }, (_, i) => (value >>> ((width - 1 - i) * 8)) & 0xff);
    })
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

/**
 * The value dnsmasq gets for a DHCPv4 option it has no type for, so it puts
 * the same bytes on the wire as a server that knows the option: a number at
 * its catalog width, a string as a string. `option` is { code, type, custom,
 * width? } and `text` the value as the scope model gives it.
 */
export function dnsmasqOption4Value(option, text) {
  if (DNSMASQ_TYPED_OPTION4.has(option.code)) return text;
  if (option.width && /^-?\d+$/.test(text)) return `${text}${WIDTH_SUFFIX[option.width]}`;
  // A list of numbers (option 25's MTU table): dnsmasq has no form for one,
  // and would read the digits as addresses, so write its bytes.
  if (option.width && /^\d+(?:\s*,\s*\d+)+$/.test(text)) return numberListBytes(text, option.width);
  const isString = option.custom
    ? option.type === 'text' || option.type === 'text-list'
    : STRING_OPTION4.has(option.code);
  return isString && !dnsmasqReadsAsText(text) ? textAsBytes(text) : text;
}
